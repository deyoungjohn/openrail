//! Reconcile, settlement distribution, and lock management (Blueprint 2.2, 2.5).

use crate::claims::compute_outstanding;
use crate::events::{
    AnomalyEvent, BookedEvent, DistributedEvent, DistributionFailedEvent, LockClearedEvent,
    ReconcileFailedEvent, SurplusReleasedEvent, TransferWindowEvent,
};
use crate::hooks::{Booking, BookingInput};
use crate::types::{Claim, Leg, Lock, Status, TokenId};
use crate::Contract;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Gas, NearToken};
use std::collections::HashMap;

/// Canonical intents multi-token contract account ID.
pub const INTENTS_ACCOUNT_ID: &str = "intents.near";

/// Gas allocated to query balances from `intents.near`.
pub const GAS_FOR_MT_BATCH_BALANCE_OF: Gas = Gas::from_tgas(10);

/// Gas allocated for the balance check callback.
pub const GAS_FOR_ON_BALANCES: Gas = Gas::from_tgas(220);

/// Gas allocated per `vault.forward` cross-contract call.
pub const GAS_FOR_VAULT_FORWARD: Gas = Gas::from_tgas(16);

/// Inner gas parameter passed to `vault.forward` for `mt_transfer`.
pub const VAULT_FORWARD_INNER_TGAS: u64 = 12;

/// Gas allocated for the distribution callback.
pub const GAS_FOR_ON_DISTRIBUTED: Gas = Gas::from_tgas(10);

/// Payload for balance check callback.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct OnBalancesArgs {
    pub token_id: String,
    pub prev_lock: Lock,
    pub since: u64,
    #[serde(default)]
    pub open_transfer_window: bool,
}

/// Payload for distribution callback.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct OnDistributedArgs {
    pub token_id: String,
    pub legs: Vec<Leg>,
    pub prev_lock: Lock,
    pub since: u64,
    pub is_retry: bool,
    #[serde(default)]
    pub open_transfer_window: bool,
    #[serde(default)]
    pub is_surplus: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VaultForwardArgs {
    pub token_id: String,
    pub amount: String,
    pub receiver_id: AccountId,
    pub gas_tgas: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MtBatchBalanceOfArgs {
    pub account_id: AccountId,
    pub token_ids: Vec<TokenId>,
}

fn restore_lock(claim: &mut Claim, prev_lock: Lock) {
    claim.lock = match prev_lock {
        Lock::TransferWindow { until } if env::block_height() < until => {
            Lock::TransferWindow { until }
        }
        _ => Lock::None,
    };
}

impl Contract {
    /// Permissionlessly initiates balance reconciliation for a claim (Blueprint 2.5).
    ///
    /// Attached gas: At least 250 Tgas required (caller attaches 250 Tgas, e.g. the watcher)
    /// to cover `mt_batch_balance_of` (10 Tgas) and `on_balances` callback (220 Tgas),
    /// which forwards up to 6 legs at 12 Tgas inner each.
    pub(crate) fn internal_reconcile(&mut self, token_id: String) {
        self.internal_reconcile_with_options(token_id, false);
    }

    /// Reconciles balances for a claim, optionally opening the transfer window on completion.
    pub(crate) fn internal_reconcile_with_options(
        &mut self,
        token_id: String,
        open_transfer_window: bool,
    ) {
        require!(
            env::prepaid_gas() >= Gas::from_tgas(230),
            "insufficient gas for reconcile"
        );

        let claim = self
            .claims
            .get_mut(&token_id)
            .unwrap_or_else(|| env::panic_str("claim not found"));

        require!(
            claim.lock.allows_transfer(),
            "reconcile requires None or TransferWindow lock"
        );

        let prev_lock = claim.lock.clone();
        let current_block = env::block_height();
        claim.lock = Lock::Reconciling {
            since: current_block,
        };

        let intents_id: AccountId = INTENTS_ACCOUNT_ID.parse().expect("valid intents account");
        let balance_args = MtBatchBalanceOfArgs {
            account_id: claim.claim_account.clone(),
            token_ids: claim.settlement_assets.clone(),
        };
        let balance_args_bytes =
            near_sdk::serde_json::to_vec(&balance_args).expect("serialize balance args");

        let batch = env::promise_create(
            intents_id,
            "mt_batch_balance_of",
            &balance_args_bytes,
            NearToken::ZERO,
            GAS_FOR_MT_BATCH_BALANCE_OF,
        );

        let callback_args = OnBalancesArgs {
            token_id,
            prev_lock,
            since: current_block,
            open_transfer_window,
        };
        let callback_bytes =
            near_sdk::serde_json::to_vec(&callback_args).expect("serialize callback args");

        let callback = env::promise_then(
            batch,
            env::current_account_id(),
            "on_balances",
            &callback_bytes,
            NearToken::ZERO,
            GAS_FOR_ON_BALANCES,
        );

        env::promise_return(callback);
    }

    /// Callback after balance query on `intents.near` resolves (Blueprint 2.5).
    pub(crate) fn handle_on_balances(
        &mut self,
        token_id: String,
        prev_lock: Lock,
        since: u64,
        open_transfer_window: bool,
    ) {
        let claim = self
            .claims
            .get_mut(&token_id)
            .unwrap_or_else(|| env::panic_str("claim not found"));

        // Stale callback check: lock must strictly equal Reconciling { since }
        if claim.lock != (Lock::Reconciling { since }) {
            ReconcileFailedEvent {
                token_id,
                reason: "stale_callback".to_string(),
            }
            .emit();
            return;
        }

        let results_count = env::promise_results_count();
        if results_count == 0 {
            restore_lock(claim, prev_lock);
            ReconcileFailedEvent {
                token_id,
                reason: "no promise results".to_string(),
            }
            .emit();
            return;
        }

        let balances_bytes = match env::promise_result_checked(0, 4096) {
            Ok(bytes) => bytes,
            Err(_) => {
                restore_lock(claim, prev_lock);
                ReconcileFailedEvent {
                    token_id,
                    reason: "mt_batch_balance_of failed".to_string(),
                }
                .emit();
                return;
            }
        };

        let balances: Vec<U128> = match near_sdk::serde_json::from_slice(&balances_bytes) {
            Ok(b) => b,
            Err(_) => {
                restore_lock(claim, prev_lock);
                ReconcileFailedEvent {
                    token_id,
                    reason: "failed to deserialize balances".to_string(),
                }
                .emit();
                return;
            }
        };

        let fee_account = self.config.fee_account.clone();

        let mut deltas: Vec<(TokenId, u128, u128)> = Vec::new();
        let mut total_delta: u128 = 0;

        for (idx, asset) in claim.settlement_assets.iter().enumerate() {
            let curr_balance = balances.get(idx).copied().unwrap_or(U128(0)).0;
            let last_seen = claim
                .last_seen_balance
                .get(asset)
                .copied()
                .unwrap_or(U128(0))
                .0;

            let d_i = if curr_balance < last_seen {
                AnomalyEvent {
                    token_id: token_id.clone(),
                    asset: asset.clone(),
                    balance: U128(curr_balance),
                    last_seen: U128(last_seen),
                }
                .emit();
                claim
                    .last_seen_balance
                    .insert(asset.clone(), U128(curr_balance));
                0
            } else {
                curr_balance - last_seen
            };

            total_delta = total_delta.saturating_add(d_i);
            deltas.push((asset.clone(), d_i, curr_balance));
        }

        // Idempotent reconcile: zero delta changes no state (beyond anomaly last_seen reset)
        if total_delta == 0 {
            if open_transfer_window {
                let until = env::block_height() + crate::types::TRANSFER_WINDOW_BLOCKS;
                claim.lock = Lock::TransferWindow { until };
                TransferWindowEvent {
                    token_id: token_id.clone(),
                    until,
                }
                .emit();
            } else {
                restore_lock(claim, prev_lock);
            }
            return;
        }

        // Booking adjustment calculation
        let (payment, credit) = if claim.status.is_terminal() || claim.status == Status::Paid {
            (0, 0)
        } else {
            let outstanding = compute_outstanding(claim);
            let input = BookingInput {
                delta: U128(total_delta),
                outstanding: U128(outstanding),
                now: env::block_timestamp_ms() / 1000,
            };
            let adj = crate::hooks::dispatch_adjust_booking(claim, input);
            (adj.payment.0, adj.credit.0)
        };

        let surplus_part = total_delta.saturating_sub(payment);
        let fee = payment
            .checked_mul(crate::FEE_BPS)
            .unwrap_or_else(|| env::panic_str("fee calculation overflow"))
            / 10_000;
        let net = payment.saturating_sub(fee);

        let mut raw_legs = crate::hooks::dispatch_split_distribution(claim, U128(net));
        if fee > 0 {
            raw_legs.push(Leg::pay(fee_account, U128(fee)));
        }
        raw_legs.retain(|leg| leg.amount().0 > 0);

        // Update claim booking counters
        claim.booked_total = U128(claim.booked_total.0.saturating_add(total_delta));
        claim.surplus = U128(claim.surplus.0.saturating_add(surplus_part));
        claim.fee_total = U128(claim.fee_total.0.saturating_add(fee));
        claim.distributed_total = U128(claim.distributed_total.0.saturating_add(net));
        claim.credit_total = U128(claim.credit_total.0.saturating_add(credit));
        if credit > 0 && claim.credit_source.is_none() {
            claim.credit_source = Some(0);
        }
        claim.update_status_paid_rule();

        // Blueprint 2.5: Allocate legs to assets in order of largest d_i first,
        // splitting a leg across assets as capacity runs out.
        // Track remaining capacity per asset (d_i is the available spendable capacity for new legs).
        struct AssetCapacity {
            asset: TokenId,
            capacity: u128,
        }

        let mut sorted_capacities: Vec<AssetCapacity> = deltas
            .iter()
            .filter(|(_, d_i, _)| *d_i > 0)
            .map(|(asset, d_i, _)| AssetCapacity {
                asset: asset.clone(),
                capacity: *d_i,
            })
            .collect();
        sorted_capacities.sort_by_key(|a| std::cmp::Reverse(a.capacity));

        let mut forwarded_per_asset: HashMap<TokenId, u128> = HashMap::new();
        let mut final_legs: Vec<Leg> = Vec::new();
        let mut current_cap_idx = 0;

        for leg in raw_legs {
            match leg {
                Leg::Pay {
                    receiver, amount, ..
                } => {
                    let mut remaining_needed = amount.0;
                    while remaining_needed > 0 {
                        while current_cap_idx < sorted_capacities.len()
                            && sorted_capacities[current_cap_idx].capacity == 0
                        {
                            current_cap_idx += 1;
                        }

                        if current_cap_idx >= sorted_capacities.len() {
                            env::panic_str("insufficient asset capacity for distribution leg");
                        }

                        let cap = &mut sorted_capacities[current_cap_idx];
                        let take = remaining_needed.min(cap.capacity);
                        cap.capacity = cap.capacity.saturating_sub(take);
                        remaining_needed = remaining_needed.saturating_sub(take);

                        *forwarded_per_asset.entry(cap.asset.clone()).or_default() += take;

                        final_legs.push(Leg::Pay {
                            receiver: receiver.clone(),
                            amount: U128(take),
                            asset: Some(cap.asset.clone()),
                        });

                        if cap.capacity == 0 {
                            current_cap_idx += 1;
                        }
                    }
                }
                Leg::Hold { .. } => {
                    // Hold legs stay in the claim account, not forwarded
                    final_legs.push(leg);
                }
            }
        }

        // Set last_seen_balance = curr_balance - sum(forwarded)
        for (asset, _d, curr_bal) in &deltas {
            let forwarded = forwarded_per_asset.get(asset).copied().unwrap_or(0);
            let new_last_seen = curr_bal.saturating_sub(forwarded);
            claim
                .last_seen_balance
                .insert(asset.clone(), U128(new_last_seen));
        }

        // Emit Booked event
        BookedEvent {
            token_id: token_id.clone(),
            payment: U128(payment),
            surplus: U128(surplus_part),
            fee: U128(fee),
            credit: U128(credit),
            legs: final_legs.clone(),
        }
        .emit();

        // Notify modules
        let booking = Booking {
            payment: U128(payment),
            surplus: U128(surplus_part),
            fee: U128(fee),
            credit: U128(credit),
            legs: final_legs.clone(),
        };
        crate::hooks::dispatch_on_booked(claim, &booking);

        let legs_to_forward: Vec<Leg> = final_legs
            .into_iter()
            .filter(|l| matches!(l, Leg::Pay { .. }))
            .collect();

        if legs_to_forward.is_empty() {
            if open_transfer_window {
                let until = env::block_height() + crate::types::TRANSFER_WINDOW_BLOCKS;
                claim.lock = Lock::TransferWindow { until };
                TransferWindowEvent {
                    token_id: token_id.clone(),
                    until,
                }
                .emit();
            } else {
                restore_lock(claim, prev_lock);
            }
            return;
        }

        let claim_account = claim.claim_account.clone();
        self.dispatch_distribution_forwards(
            &token_id,
            claim_account,
            legs_to_forward,
            prev_lock,
            since,
            false,
            open_transfer_window,
            false,
        );
    }

    /// Dispatches forwards to the vault sub-account and schedules `on_distributed`.
    pub(crate) fn dispatch_distribution_forwards(
        &mut self,
        token_id: &str,
        claim_account: AccountId,
        legs: Vec<Leg>,
        prev_lock: Lock,
        since: u64,
        is_retry: bool,
        open_transfer_window: bool,
        is_surplus: bool,
    ) {
        let mut forward_promises = Vec::with_capacity(legs.len());

        for leg in &legs {
            if let Leg::Pay {
                receiver,
                amount,
                asset,
            } = leg
            {
                let asset_str = asset
                    .as_deref()
                    .unwrap_or_else(|| env::panic_str("leg without asset"));
                let forward_args = VaultForwardArgs {
                    token_id: asset_str.to_string(),
                    amount: amount.0.to_string(),
                    receiver_id: receiver.clone(),
                    gas_tgas: VAULT_FORWARD_INNER_TGAS,
                };
                let forward_bytes = near_sdk::serde_json::to_vec(&forward_args)
                    .expect("serialize vault forward args");

                let p = env::promise_create(
                    claim_account.clone(),
                    "forward",
                    &forward_bytes,
                    NearToken::ZERO,
                    GAS_FOR_VAULT_FORWARD,
                );
                forward_promises.push(p);
            }
        }

        if forward_promises.is_empty() {
            let claim = self
                .claims
                .get_mut(token_id)
                .unwrap_or_else(|| env::panic_str("claim not found"));
            if !is_retry {
                if open_transfer_window {
                    let until = env::block_height() + crate::types::TRANSFER_WINDOW_BLOCKS;
                    claim.lock = Lock::TransferWindow { until };
                    TransferWindowEvent {
                        token_id: token_id.to_string(),
                        until,
                    }
                    .emit();
                } else {
                    restore_lock(claim, prev_lock);
                }
            } else {
                restore_lock(claim, prev_lock);
            }
            return;
        }

        let joined = if forward_promises.len() == 1 {
            forward_promises[0]
        } else {
            env::promise_and(&forward_promises)
        };

        let callback_args = OnDistributedArgs {
            token_id: token_id.to_string(),
            legs,
            prev_lock,
            since,
            is_retry,
            open_transfer_window,
            is_surplus,
        };
        let callback_bytes =
            near_sdk::serde_json::to_vec(&callback_args).expect("serialize on_distributed args");

        let callback = env::promise_then(
            joined,
            env::current_account_id(),
            "on_distributed",
            &callback_bytes,
            NearToken::ZERO,
            GAS_FOR_ON_DISTRIBUTED,
        );

        env::promise_return(callback);
    }

    /// Callback after distribution forwards finish (D-S8 invariant: failed leg never unbooks).
    pub(crate) fn handle_on_distributed(
        &mut self,
        token_id: String,
        legs: Vec<Leg>,
        prev_lock: Lock,
        since: u64,
        is_retry: bool,
        open_transfer_window: bool,
        is_surplus: bool,
    ) {
        let claim = self
            .claims
            .get_mut(&token_id)
            .unwrap_or_else(|| env::panic_str("claim not found"));

        if claim.lock != (Lock::Reconciling { since }) {
            ReconcileFailedEvent {
                token_id,
                reason: "stale_callback".to_string(),
            }
            .emit();
            return;
        }

        let results_count = env::promise_results_count();

        for (idx, leg) in legs.into_iter().enumerate() {
            let succeeded = idx < results_count as usize
                && env::promise_result_checked(idx as u64, 4096).is_ok();

            let asset = leg
                .asset()
                .cloned()
                .unwrap_or_else(|| env::panic_str("leg without asset"));

            if succeeded {
                if is_retry {
                    if let Some(ls) = claim.last_seen_balance.get_mut(&asset) {
                        *ls = U128(ls.0.saturating_sub(leg.amount().0));
                    }
                }
                DistributedEvent {
                    token_id: token_id.clone(),
                    leg: leg.clone(),
                }
                .emit();

                if is_surplus {
                    SurplusReleasedEvent {
                        token_id: token_id.clone(),
                        amount: leg.amount(),
                        receiver_id: leg
                            .receiver()
                            .cloned()
                            .unwrap_or_else(|| claim.owner_id.clone()),
                    }
                    .emit();
                }
            } else {
                // D-S8: failed leg is recorded into undistributed; booking counters stand!
                let mut und = self
                    .undistributed
                    .get(&token_id)
                    .cloned()
                    .unwrap_or_default();
                und.push(leg.clone());
                self.undistributed.insert(token_id.clone(), und);

                if !is_retry {
                    let cur = claim
                        .last_seen_balance
                        .get(&asset)
                        .copied()
                        .unwrap_or(U128(0))
                        .0;
                    claim
                        .last_seen_balance
                        .insert(asset.clone(), U128(cur.saturating_add(leg.amount().0)));
                }

                DistributionFailedEvent {
                    token_id: token_id.clone(),
                    leg,
                    reason: Some("forward promise failed".to_string()),
                }
                .emit();
            }
        }

        if !is_retry {
            if open_transfer_window {
                let until = env::block_height() + crate::types::TRANSFER_WINDOW_BLOCKS;
                claim.lock = Lock::TransferWindow { until };
                TransferWindowEvent {
                    token_id: token_id.clone(),
                    until,
                }
                .emit();
            } else {
                restore_lock(claim, prev_lock);
            }
        } else {
            restore_lock(claim, prev_lock);
        }
    }

    /// Retries failed distribution legs to their originally recorded receivers (D-S8).
    pub(crate) fn internal_retry_distribution(&mut self, token_id: String) {
        let claim = self
            .claims
            .get_mut(&token_id)
            .unwrap_or_else(|| env::panic_str("claim not found"));

        require!(
            claim.lock.allows_transfer(),
            "cannot retry while reconciling"
        );

        let undistributed = self.undistributed.remove(&token_id).unwrap_or_default();

        require!(!undistributed.is_empty(), "no undistributed legs");

        let prev_lock = claim.lock.clone();
        let current_block = env::block_height();
        claim.lock = Lock::Reconciling {
            since: current_block,
        };

        let claim_account = claim.claim_account.clone();
        self.dispatch_distribution_forwards(
            &token_id,
            claim_account,
            undistributed,
            prev_lock,
            current_block,
            true,
            false,
            false,
        );
    }

    /// Clears expired locks (`Reconciling` > 100 blocks, or `TransferWindow`/`Module` past until).
    pub(crate) fn internal_clear_stale_lock(&mut self, token_id: String) {
        let claim = self
            .claims
            .get_mut(&token_id)
            .unwrap_or_else(|| env::panic_str("claim not found"));

        let current_block = env::block_height();
        let is_stale = match &claim.lock {
            Lock::Reconciling { since } => current_block.saturating_sub(*since) > 100,
            Lock::TransferWindow { until } => current_block >= *until,
            Lock::Module { until, .. } => current_block >= *until,
            Lock::None => false,
        };

        if !is_stale {
            return;
        }

        let cleared_lock = std::mem::replace(&mut claim.lock, Lock::None);
        LockClearedEvent {
            token_id,
            cleared_lock,
        }
        .emit();
    }
}
