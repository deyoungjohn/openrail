//! Reconcile, settlement distribution, and lock management (Blueprint 2.2, 2.5).

use crate::claims::compute_outstanding;
use crate::events::{
    AnomalyEvent, BookedEvent, DistributedEvent, DistributionFailedEvent, LockClearedEvent,
    ReconcileFailedEvent,
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
}

/// Payload for distribution callback.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct OnDistributedArgs {
    pub token_id: String,
    pub legs: Vec<Leg>,
    pub prev_lock: Lock,
    pub is_retry: bool,
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
    pub(crate) fn internal_reconcile(&mut self, token_id: String) {
        let claim = self
            .claims
            .get_mut(&token_id)
            .unwrap_or_else(|| env::panic_str("claim not found"));

        require!(
            claim.lock.allows_transfer(),
            "reconcile requires None or TransferWindow lock"
        );

        let prev_lock = claim.lock.clone();
        claim.lock = Lock::Reconciling {
            since: env::block_height(),
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
    pub(crate) fn handle_on_balances(&mut self, token_id: String, prev_lock: Lock) {
        let results_count = env::promise_results_count();
        if results_count == 0 {
            self.fail_reconcile(&token_id, prev_lock, "no promise results");
            return;
        }

        let balances_bytes = match env::promise_result_checked(0, 4096) {
            Ok(bytes) => bytes,
            Err(_) => {
                self.fail_reconcile(&token_id, prev_lock, "mt_batch_balance_of failed");
                return;
            }
        };

        let balances: Vec<U128> = match near_sdk::serde_json::from_slice(&balances_bytes) {
            Ok(b) => b,
            Err(_) => {
                self.fail_reconcile(&token_id, prev_lock, "failed to deserialize balances");
                return;
            }
        };

        let fee_account = self.config.fee_account.clone();
        let claim = self
            .claims
            .get_mut(&token_id)
            .unwrap_or_else(|| env::panic_str("claim not found"));

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
            restore_lock(claim, prev_lock);
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
        let fee = (payment * crate::FEE_BPS) / 10_000;
        let net = payment.saturating_sub(fee);

        let mut legs = crate::hooks::dispatch_split_distribution(claim, U128(net));
        if fee > 0 {
            legs.push(Leg::pay(fee_account, U128(fee)));
        }
        legs.retain(|leg| leg.amount().0 > 0);

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

        // Assign settlement assets to legs (largest delta first)
        deltas.sort_by_key(|a| std::cmp::Reverse(a.1));
        let mut asset_idx = 0;
        let mut forwarded_per_asset: HashMap<TokenId, u128> = HashMap::new();
        let mut legs_to_forward: Vec<Leg> = Vec::new();

        for leg in &mut legs {
            while asset_idx < deltas.len() && deltas[asset_idx].1 == 0 {
                asset_idx += 1;
            }
            let chosen_asset = if asset_idx < deltas.len() {
                deltas[asset_idx].0.clone()
            } else {
                claim.settlement_assets[0].clone()
            };
            leg.set_asset(chosen_asset.clone());

            if let Leg::Pay { amount, .. } = leg {
                *forwarded_per_asset.entry(chosen_asset).or_default() += amount.0;
                legs_to_forward.push(leg.clone());
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
            legs: legs.clone(),
        }
        .emit();

        // Notify modules
        let booking = Booking {
            payment: U128(payment),
            surplus: U128(surplus_part),
            fee: U128(fee),
            credit: U128(credit),
            legs: legs.clone(),
        };
        crate::hooks::dispatch_on_booked(claim, &booking);

        if legs_to_forward.is_empty() {
            restore_lock(claim, prev_lock);
            return;
        }

        let claim_account = claim.claim_account.clone();
        self.dispatch_distribution_forwards(
            &token_id,
            claim_account,
            legs_to_forward,
            prev_lock,
            false,
        );
    }

    /// Dispatches forwards to the vault sub-account and schedules `on_distributed`.
    fn dispatch_distribution_forwards(
        &mut self,
        token_id: &str,
        claim_account: AccountId,
        legs: Vec<Leg>,
        prev_lock: Lock,
        is_retry: bool,
    ) {
        let mut forward_promises = Vec::with_capacity(legs.len());

        for leg in &legs {
            if let Leg::Pay {
                receiver,
                amount,
                asset,
            } = leg
            {
                let asset_str = asset.as_deref().unwrap_or("nep141:usdc.omft.near");
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
            restore_lock(claim, prev_lock);
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
            is_retry,
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
        is_retry: bool,
    ) {
        let results_count = env::promise_results_count();

        for (idx, leg) in legs.into_iter().enumerate() {
            let succeeded = idx < results_count as usize
                && env::promise_result_checked(idx as u64, 4096).is_ok();

            if succeeded {
                if is_retry {
                    if let Some(asset) = leg.asset() {
                        let claim = self
                            .claims
                            .get_mut(&token_id)
                            .unwrap_or_else(|| env::panic_str("claim not found"));
                        if let Some(ls) = claim.last_seen_balance.get_mut(asset) {
                            *ls = U128(ls.0.saturating_sub(leg.amount().0));
                        }
                    }
                }
                DistributedEvent {
                    token_id: token_id.clone(),
                    leg,
                }
                .emit();
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
                    if let Some(asset) = leg.asset() {
                        let claim = self
                            .claims
                            .get_mut(&token_id)
                            .unwrap_or_else(|| env::panic_str("claim not found"));
                        let cur = claim
                            .last_seen_balance
                            .get(asset)
                            .copied()
                            .unwrap_or(U128(0))
                            .0;
                        claim
                            .last_seen_balance
                            .insert(asset.clone(), U128(cur.saturating_add(leg.amount().0)));
                    }
                }

                DistributionFailedEvent {
                    token_id: token_id.clone(),
                    leg,
                    reason: Some("forward promise failed".to_string()),
                }
                .emit();
            }
        }

        let claim = self
            .claims
            .get_mut(&token_id)
            .unwrap_or_else(|| env::panic_str("claim not found"));
        restore_lock(claim, prev_lock);
    }

    /// Retries failed distribution legs to their originally recorded receivers (D-S8).
    pub(crate) fn internal_retry_distribution(&mut self, token_id: String) {
        let claim = self
            .claims
            .get(&token_id)
            .unwrap_or_else(|| env::panic_str("claim not found"));

        let undistributed = self.undistributed.remove(&token_id).unwrap_or_default();

        require!(!undistributed.is_empty(), "no undistributed legs");

        let claim_account = claim.claim_account.clone();
        self.dispatch_distribution_forwards(
            &token_id,
            claim_account,
            undistributed,
            Lock::None,
            true,
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

    fn fail_reconcile(&mut self, token_id: &str, prev_lock: Lock, reason: &str) {
        let claim = self
            .claims
            .get_mut(token_id)
            .unwrap_or_else(|| env::panic_str("claim not found"));
        claim.lock = prev_lock;
        ReconcileFailedEvent {
            token_id: token_id.to_string(),
            reason: reason.to_string(),
        }
        .emit();
    }
}
