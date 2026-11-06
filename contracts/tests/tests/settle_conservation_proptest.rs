//! Property test for value conservation with settle feature on and off.
//!
//! Blueprint references:
//! - blueprint/modules/settle.md
//! - blueprint/02-core.md §2.11 (conservation_v3)
//!
//! Property under test:
//! For random interleaved sequences of book, settle_payout, refund, report_payout, release:
//! Value conservation holds:
//! `booked_total == distributed + fee + surplus + held (+ released)`
//! Tested both with settlement destination active (held path) and inactive (core default path).

use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{test_vm_config, testing_env, AccountId, PromiseResult, RuntimeFeesConfig};
use openrail::types::{Claim, Config, Hex32, Lock, Status};
use openrail::Contract;
use proptest::prelude::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

const ASSET: &str = "nep141:usdc.near";
const ROOT: &str = "openrail.near";
#[cfg(feature = "settle")]
const RELAYER: &str = "relayer.openrail.near";
#[cfg(feature = "settle")]
const BASE_ADDR: &str = "0x1111111111111111111111111111111111111111";

static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn set_ctx(predecessor: &str, results: Vec<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ROOT))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .block_height(1_000)
        .prepaid_gas(near_sdk::Gas::from_tgas(300));
    testing_env!(
        b.build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        results
    );
}

struct PropEnv {
    contract: Contract,
    token_id: String,
    #[allow(dead_code)]
    biz: AccountId,
}

fn create_env() -> PropEnv {
    let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
    let token_id = format!("c-prop-{id}");
    let biz: AccountId = format!("biz{id}.near").parse().unwrap();
    let claim_acc: AccountId = format!("c-prop-{id}.{ROOT}").parse().unwrap();

    set_ctx(ROOT, vec![]);
    let mut c = Contract::new(Config {
        settlement_assets: vec![ASSET.to_string()],
        vault_code_hash: Hex32::new([0; 32]),
        fee_account: acc("fees.openrail.near"),
        watchers: vec![],
        quote_writers: vec![],
        issuers: vec![],
        issue_paused: false,
    });
    #[cfg(feature = "settle")]
    c.set_payout_relayers(vec![acc(RELAYER)]);

    c.claims.insert(
        token_id.clone(),
        Claim {
            token_id: token_id.clone(),
            kind: 0,
            issuer_id: biz.clone(),
            owner_id: biz.clone(),
            claim_account: claim_acc,
            debtor: None,
            terms_hash: Hex32::new([1; 32]),
            amount_due: U128(1_000_000_000), // $1,000 max capacity
            due_date: 0,
            ack: None,
            status: Status::Issued,
            lock: Lock::None,
            settlement_assets: vec![ASSET.to_string()],
            booked_total: U128(0),
            distributed_total: U128(0),
            fee_total: U128(0),
            surplus: U128(0),
            credit_total: U128(0),
            credit_source: None,
            last_seen_balance: [(ASSET.to_string(), U128(0))].into_iter().collect(),
            assignment_doc_hash: None,
            created_block: 100,
        },
    );
    PropEnv {
        contract: c,
        token_id,
        biz,
    }
}

#[derive(Clone, Debug)]
enum PropAction {
    SetDestination(bool),
    Book(u128),
    Payout { entry_idx: u32, amount: u128 },
    ReportSettled { entry_idx: u32 },
    ReportRefund { entry_idx: u32, amount: u128 },
    Release { entry_idx: u32 },
}

fn arb_action() -> impl Strategy<Value = PropAction> {
    prop_oneof![
        any::<bool>().prop_map(PropAction::SetDestination),
        (1_000u128..=50_000_000u128).prop_map(PropAction::Book),
        (0u32..=3u32, 1_000u128..=20_000_000u128)
            .prop_map(|(entry_idx, amount)| PropAction::Payout { entry_idx, amount }),
        (0u32..=3u32).prop_map(|entry_idx| PropAction::ReportSettled { entry_idx }),
        (0u32..=3u32, 1_000u128..=20_000_000u128)
            .prop_map(|(entry_idx, amount)| PropAction::ReportRefund { entry_idx, amount }),
        (0u32..=3u32).prop_map(|entry_idx| PropAction::Release { entry_idx }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 300, ..ProptestConfig::default() })]

    #[test]
    fn prop_test_value_conservation_random_sequence(actions in prop::collection::vec(arb_action(), 1..=25)) {
        let PropEnv {
            mut contract,
            token_id,
            #[cfg(feature = "settle")]
            biz,
            #[cfg(not(feature = "settle"))]
            biz: _,
        } = create_env();
        #[cfg(feature = "settle")]
        let mut inflight_payouts: HashMap<u32, u64> = HashMap::new();
        #[cfg(feature = "settle")]
        let mut unrefunded_loss = 0u128;

        for action in actions {
            match action {
                PropAction::SetDestination(enabled) => {
                    #[cfg(feature = "settle")]
                    {
                        set_ctx(biz.as_str(), vec![]);
                        if enabled {
                            contract.set_settlement("base".to_string(), BASE_ADDR.to_string(), U128(10_000));
                        } else {
                            contract.clear_settlement();
                        }
                    }
                    #[cfg(not(feature = "settle"))]
                    let _ = enabled;
                }
                PropAction::Book(delta) => {
                    let claim = contract.claims.get_mut(&token_id).unwrap();
                    if claim.lock != Lock::None {
                        continue;
                    }
                    claim.lock = Lock::Reconciling { since: 7 };
                    let current_bal = claim
                        .last_seen_balance.get(ASSET).copied().unwrap_or(U128(0)).0;
                    let new_bal = current_bal.saturating_add(delta);

                    let balance_result = near_sdk::serde_json::to_vec(&vec![U128(new_bal)]).unwrap();
                    set_ctx(ROOT, vec![PromiseResult::Successful(balance_result)]);

                    // Reconcile callback with observed new balance
                    contract.on_balances(
                        token_id.clone(),
                        Lock::None,
                        7,
                        Some(false),
                    );
                    let claim = contract.claims.get_mut(&token_id).unwrap();
                    if claim.lock == (Lock::Reconciling { since: 7 }) {
                        claim.lock = Lock::None;
                    }
                }
                PropAction::Payout { entry_idx, amount } => {
                    #[cfg(feature = "settle")]
                    {
                        if contract.claims.get(&token_id).unwrap().lock == Lock::None
                            && contract.settlement_of(biz.clone()).is_some()
                        {
                            set_ctx(RELAYER, vec![]);
                            let entries = contract.settle_held(token_id.clone());
                            if let Some(entry) = entries.get(entry_idx as usize) {
                                let seen = contract.claims.get(&token_id).unwrap()
                                    .last_seen_balance.get(&entry.asset).copied().unwrap_or(U128(0)).0;
                                if matches!(entry.status, openrail::modules::settle::HeldStatus::Held)
                                    && entry.amount.0 >= amount
                                    && amount > 0
                                    && seen >= amount
                                {
                                    let payout_id = contract.settle_payout(
                                        token_id.clone(),
                                        entry_idx,
                                        acc("deposit.target.near"),
                                        U128(amount),
                                    );
                                    // Mock successful forward callback
                                    set_ctx(ROOT, vec![PromiseResult::Successful(vec![])]);
                                    contract.on_payout(payout_id);
                                    inflight_payouts.insert(entry_idx, payout_id);
                                }
                            }
                        }
                    }
                    #[cfg(not(feature = "settle"))]
                    {
                        let _ = (entry_idx, amount);
                    }
                }
                PropAction::ReportSettled { entry_idx } => {
                    #[cfg(feature = "settle")]
                    {
                        if let Some(payout_id) = inflight_payouts.remove(&entry_idx) {
                            set_ctx(RELAYER, vec![]);
                            contract.report_payout(
                                token_id.clone(),
                                entry_idx,
                                payout_id,
                                openrail::modules::settle::PayoutOutcome::Settled {
                                    destination_tx: "0xtx_valid".to_string(),
                                },
                            );
                        }
                    }
                    #[cfg(not(feature = "settle"))]
                    let _ = entry_idx;
                }
                PropAction::ReportRefund { entry_idx, amount } => {
                    #[cfg(feature = "settle")]
                    {
                        if let Some(payout_id) = inflight_payouts.remove(&entry_idx) {
                            set_ctx(RELAYER, vec![]);
                            if let Some(sent) = openrail::modules::payout::get(payout_id) {
                                let capped_amount = amount.min(sent.amount_in.0);
                                unrefunded_loss += sent.amount_in.0 - capped_amount;
                                contract.report_payout(
                                    token_id.clone(),
                                    entry_idx,
                                    payout_id,
                                    openrail::modules::settle::PayoutOutcome::Refunded {
                                        amount: U128(capped_amount),
                                    },
                                );
                            }
                        }
                    }
                    #[cfg(not(feature = "settle"))]
                    {
                        let _ = (entry_idx, amount);
                    }
                }
                PropAction::Release { entry_idx } => {
                    #[cfg(feature = "settle")]
                    {
                        if contract.claims.get(&token_id).unwrap().lock == Lock::None {
                            let entries = contract.settle_held(token_id.clone());
                            if let Some(entry) = entries.get(entry_idx as usize) {
                                let seen = contract.claims.get(&token_id).unwrap()
                                    .last_seen_balance.get(&entry.asset).copied().unwrap_or(U128(0)).0;
                                if matches!(entry.status, openrail::modules::settle::HeldStatus::Held | openrail::modules::settle::HeldStatus::Flagged { .. })
                                    && seen >= entry.amount.0
                                    && entry.amount.0 > 0
                                {
                                    set_ctx(biz.as_str(), vec![]);
                                    let payout_id = contract.settle_release(token_id.clone(), entry_idx);
                                    set_ctx(ROOT, vec![PromiseResult::Successful(vec![])]);
                                    contract.on_payout(payout_id);
                                }
                            }
                        }
                    }
                    #[cfg(not(feature = "settle"))]
                    let _ = entry_idx;
                }
            }

            // Invariant verification after EVERY single step:
            let claim = contract.claims.get(&token_id).unwrap();

            // 1. Core invariant: booked_total == distributed_total + fee_total + surplus
            prop_assert_eq!(
                claim.booked_total.0,
                claim.distributed_total.0 + claim.fee_total.0 + claim.surplus.0,
                "Core conservation failed: booked != distributed + fee + surplus"
            );

            // 2. Module conservation (with settle feature):
            // When settle is on, distributed_total accounts for:
            // sum of held entries (held, inflight, flagged, released, settled) + direct distributions + unrefunded loss
            #[cfg(feature = "settle")]
            {
                let held_entries = contract.settle_held(token_id.clone());
                let mut sum_held = 0u128;
                let mut sum_inflight = 0u128;
                let mut sum_settled = 0u128;
                let mut sum_released = 0u128;
                for entry in &held_entries {
                    match entry.status {
                        openrail::modules::settle::HeldStatus::Held | openrail::modules::settle::HeldStatus::Flagged { .. } => {
                            sum_held = sum_held.saturating_add(entry.amount.0);
                        }
                        openrail::modules::settle::HeldStatus::InFlight { .. } => {
                            sum_inflight = sum_inflight.saturating_add(entry.amount.0);
                        }
                        openrail::modules::settle::HeldStatus::Settled { .. } => {
                            sum_settled = sum_settled.saturating_add(entry.amount.0);
                        }
                        openrail::modules::settle::HeldStatus::Released { .. } => {
                            sum_released = sum_released.saturating_add(entry.amount.0);
                        }
                    }
                }
                let total_held_tracked = sum_held + sum_inflight + sum_settled + sum_released;
                prop_assert!(
                    total_held_tracked + unrefunded_loss <= claim.distributed_total.0,
                    "Tracked held value ({}) + loss ({}) exceeds distributed_total ({})",
                    total_held_tracked,
                    unrefunded_loss,
                    claim.distributed_total.0
                );

                let distributed_direct = claim.distributed_total.0.saturating_sub(total_held_tracked + unrefunded_loss);
                prop_assert_eq!(
                    claim.booked_total.0,
                    distributed_direct + claim.fee_total.0 + claim.surplus.0 + (sum_held + sum_inflight) + (sum_settled + sum_released) + unrefunded_loss,
                    "Conservation with held/released failed"
                );
            }
        }
    }
}
