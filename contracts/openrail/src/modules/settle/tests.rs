//! Unit tests for `settle` and the `payout` component (names from settle.md and _payout.md).
//! Run: cargo test -p openrail --features settle --lib modules::

use super::*;
use crate::modules::payout::{self as po, PayoutStatus};
use crate::types::{Claim, Config, Hex32, Lock, Status};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};
use std::collections::HashMap;

const ASSET: &str = "nep141:usdc.near";
const ROOT: &str = "openrail.near";
const BIZ: &str = "studio.near";
const BUYER: &str = "buyer.near";
const RELAYER: &str = "relayer.openrail.near";
const DEPOSIT: &str = "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d";
const BASE_ADDR: &str = "0x1111111111111111111111111111111111111111";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, results: Vec<PromiseResult>) {
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

fn contract() -> Contract {
    ctx(ROOT, vec![]);
    let mut c = Contract::new(Config {
        settlement_assets: vec![ASSET.to_string()],
        vault_code_hash: Hex32::new([0; 32]),
        fee_account: acc("fees.openrail.near"),
        watchers: vec![],
        quote_writers: vec![],
        issuers: vec![],
        issue_paused: false,
    });
    c.set_payout_relayers(vec![acc(RELAYER)]);
    c.claims.insert("c-1".to_string(), claim("c-1", 10_000_000));
    c
}

fn claim(token_id: &str, amount_due: u128) -> Claim {
    Claim {
        token_id: token_id.to_string(),
        kind: 0,
        issuer_id: acc(BIZ),
        owner_id: acc(BIZ),
        claim_account: acc(&format!("{token_id}.{ROOT}")),
        debtor: None,
        terms_hash: Hex32::new([1; 32]),
        amount_due: U128(amount_due),
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
        last_seen_balance: HashMap::new(),
        assignment_doc_hash: None,
        created_block: 1,
    }
}

/// Simulates reconcile seeing `balance` on the claim account.
fn book(c: &mut Contract, balance: u128) {
    c.claims.get_mut("c-1").unwrap().lock = Lock::Reconciling { since: 7 };
    let bytes = near_sdk::serde_json::to_vec(&vec![U128(balance)]).unwrap();
    ctx(ROOT, vec![PromiseResult::Successful(bytes)]);
    c.on_balances("c-1".to_string(), Lock::None, 7, None);
    // The fee leg is forwarded; `on_distributed` (covered by the c4 sandbox suite) then
    // restores the lock. Simulate it.
    let claim = c.claims.get_mut("c-1").unwrap();
    if claim.lock == (Lock::Reconciling { since: 7 }) {
        claim.lock = Lock::None;
    }
}

fn set_destination(c: &mut Contract, who: &str, min: u128) {
    ctx(who, vec![]);
    c.set_settlement("base".to_string(), BASE_ADDR.to_string(), U128(min));
}

fn booked_legs() -> Vec<near_sdk::serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).unwrap())
        .filter(|v| v["event"] == "booked")
        .flat_map(|v| v["data"][0]["legs"].as_array().cloned().unwrap_or_default())
        .collect()
}

fn events(name: &str) -> Vec<near_sdk::serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).unwrap())
        .filter(|v| v["event"] == name)
        .map(|v| v["data"][0].clone())
        .collect()
}

fn last_seen(c: &Contract) -> u128 {
    c.claims
        .get("c-1")
        .unwrap()
        .last_seen_balance
        .get(ASSET)
        .copied()
        .unwrap_or(U128(0))
        .0
}

fn pay_out(c: &mut Contract, amount: u128) -> u64 {
    ctx(RELAYER, vec![]);
    c.settle_payout("c-1".to_string(), 0, acc(DEPOSIT), U128(amount))
}

fn forward_result(c: &mut Contract, payout_id: u64, ok: bool) {
    let result = if ok {
        PromiseResult::Successful(vec![])
    } else {
        PromiseResult::Failed
    };
    ctx(ROOT, vec![result]);
    c.on_payout(payout_id);
}

// ── settle.md ────────────────────────────────────────────────────────────────

#[test]
fn settle_holds_owner_share_when_destination_set() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 1_000_000);
    book(&mut c, 2_000_000);
    // 25 bps fee 5_000 is paid; the owner's net 1_995_000 is held, with its asset recorded.
    let held = held_of("c-1");
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].owner, acc(BIZ));
    assert_eq!(held[0].asset, ASSET);
    assert_eq!(held[0].amount, U128(1_995_000));
    assert_eq!(held[0].status, HeldStatus::Held);
    let legs = booked_legs();
    assert!(legs
        .iter()
        .any(|l| l["Hold"]["amount"] == "1995000" && l["Hold"]["asset"] == ASSET));
    assert!(legs
        .iter()
        .all(|l| l.get("Pay").is_none_or(|p| p["receiver"] != BIZ)));
    // Held value stays seen in the claim account: a second reconcile books nothing new.
    assert_eq!(last_seen(&c), 1_995_000);
    book(&mut c, 1_995_000);
    assert_eq!(held_of("c-1").len(), 1);
}

#[test]
fn settle_default_when_no_destination() {
    let mut c = contract();
    book(&mut c, 2_000_000);
    assert!(held_of("c-1").is_empty());
    assert!(booked_legs()
        .iter()
        .any(|l| l["Pay"]["receiver"] == BIZ && l["Pay"]["amount"] == "1995000"));
}

#[test]
fn settle_below_min_pays_core_default() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 5_000_000);
    book(&mut c, 2_000_000);
    assert!(held_of("c-1").is_empty());
    assert!(booked_legs().iter().any(|l| l["Pay"]["receiver"] == BIZ));
}

#[test]
fn settle_destination_set_only_by_business() {
    let mut c = contract();
    // Someone else setting "a destination" only sets their own; the business's stays unset.
    set_destination(&mut c, BUYER, 0);
    assert_eq!(c.settlement_of(acc(BIZ)), None);
    assert!(c.settlement_of(acc(BUYER)).is_some());
    book(&mut c, 2_000_000);
    assert!(held_of("c-1").is_empty());
}

#[test]
#[should_panic(expected = "SETTLE_CHAIN_REFUSED")]
fn settle_bnb_refused() {
    let mut c = contract();
    ctx(BIZ, vec![]);
    c.set_settlement("BNB".to_string(), BASE_ADDR.to_string(), U128(0));
}

#[test]
fn settle_address_formats() {
    let _c = contract();
    assert_eq!(validate_destination("Base", BASE_ADDR), "base");
    assert_eq!(
        validate_destination("solana", "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV"),
        "solana"
    );
    assert_eq!(validate_destination("near", "studio.near"), "near");
    for (chain, address) in [
        ("base", "0x123"),
        ("ethereum", "1111111111111111111111111111111111111111zz"),
        ("solana", "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"),
        ("near", "Not An Account"),
        ("dogecoin", BASE_ADDR),
    ] {
        let r = std::panic::catch_unwind(|| validate_destination(chain, address));
        assert!(r.is_err(), "{chain} {address} should be refused");
    }
}

#[test]
#[should_panic(expected = "PAYOUT_NOT_RELAYER")]
fn settle_payout_only_allowlisted() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    ctx(BIZ, vec![]);
    c.settle_payout("c-1".to_string(), 0, acc(DEPOSIT), U128(1_995_000));
}

#[test]
#[should_panic(expected = "SETTLE_AMOUNT_EXCEEDS_HELD")]
fn settle_payout_amount_le_held() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    pay_out(&mut c, 1_995_001);
}

#[test]
fn settle_partial_payout_keeps_rest_held() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    let id = pay_out(&mut c, 1_000_000);
    let held = held_of("c-1");
    assert_eq!(held[0].amount, U128(1_000_000));
    assert_eq!(held[0].status, HeldStatus::InFlight { payout_id: id });
    assert_eq!(held[1].amount, U128(995_000));
    assert_eq!(held[1].status, HeldStatus::Held);
    assert_eq!(held[1].owner, acc(BIZ));
}

#[test]
#[should_panic(expected = "NOT_IN_FLIGHT")]
fn settle_report_not_in_flight_panics() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    ctx(RELAYER, vec![]);
    c.report_payout(
        "c-1".to_string(),
        0,
        1,
        PayoutOutcome::Settled {
            destination_tx: "0xabc".to_string(),
        },
    );
}

#[test]
#[should_panic(expected = "NOT_IN_FLIGHT")]
fn settle_report_before_forward_resolves_panics() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    let id = pay_out(&mut c, 1_995_000);
    ctx(RELAYER, vec![]);
    c.report_payout(
        "c-1".to_string(),
        0,
        id,
        PayoutOutcome::Settled {
            destination_tx: "0xabc".into(),
        },
    );
}

#[test]
fn settle_settled_path_moves_last_seen_and_unlocks() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    let id = pay_out(&mut c, 1_995_000);
    assert!(matches!(
        c.claims.get("c-1").unwrap().lock,
        Lock::Module { .. }
    ));
    forward_result(&mut c, id, true);
    assert_eq!(last_seen(&c), 0);
    assert_eq!(po::get(id).unwrap().status, PayoutStatus::Sent);
    // Still locked until the relayer reports: a refund must not be booked as a payment.
    assert!(matches!(
        c.claims.get("c-1").unwrap().lock,
        Lock::Module { .. }
    ));
    ctx(RELAYER, vec![]);
    c.report_payout(
        "c-1".to_string(),
        0,
        id,
        PayoutOutcome::Settled {
            destination_tx: "0xbase".into(),
        },
    );
    assert_eq!(c.claims.get("c-1").unwrap().lock, Lock::None);
    assert_eq!(
        held_of("c-1")[0].status,
        HeldStatus::Settled {
            payout_id: id,
            destination_tx: "0xbase".into()
        }
    );
    // The next reconcile at the now-empty balance books nothing and raises no anomaly.
    book(&mut c, 0);
    assert!(events("anomaly").is_empty());
    assert_eq!(c.claims.get("c-1").unwrap().booked_total, U128(2_000_000));
}

#[test]
fn settle_forward_failure_holds_again_and_unlocks() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    let id = pay_out(&mut c, 1_995_000);
    forward_result(&mut c, id, false);
    assert_eq!(held_of("c-1")[0].status, HeldStatus::Held);
    assert_eq!(last_seen(&c), 1_995_000);
    assert_eq!(c.claims.get("c-1").unwrap().lock, Lock::None);
    assert_eq!(po::get(id).unwrap().status, PayoutStatus::Failed);
}

#[test]
#[should_panic(expected = "SETTLE_CLAIM_LOCKED")]
fn settle_payout_refused_while_reconciling() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    c.claims.get_mut("c-1").unwrap().lock = Lock::Reconciling { since: 9 };
    pay_out(&mut c, 1_995_000);
}

#[test]
#[should_panic(expected = "reconcile requires None or TransferWindow lock")]
fn settle_reconcile_waits_while_payout_out() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    pay_out(&mut c, 1_995_000);
    ctx(BUYER, vec![]);
    c.reconcile("c-1".to_string());
}

#[test]
fn settle_refund_returns_to_held_and_retries_once() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    let first = pay_out(&mut c, 1_995_000);
    forward_result(&mut c, first, true);
    ctx(RELAYER, vec![]);
    c.report_payout(
        "c-1".to_string(),
        0,
        first,
        PayoutOutcome::Refunded {
            amount: U128(1_995_000),
        },
    );
    let held = held_of("c-1");
    assert_eq!(held[0].status, HeldStatus::Held);
    assert_eq!(held[0].retries, 1);
    assert_eq!(last_seen(&c), 1_995_000);
    assert_eq!(c.claims.get("c-1").unwrap().lock, Lock::None);
    // The refund is not booked as a new payment.
    book(&mut c, 1_995_000);
    assert_eq!(c.claims.get("c-1").unwrap().booked_total, U128(2_000_000));

    let second = pay_out(&mut c, 1_995_000);
    forward_result(&mut c, second, true);
    ctx(RELAYER, vec![]);
    c.report_payout(
        "c-1".to_string(),
        0,
        second,
        PayoutOutcome::Refunded {
            amount: U128(1_995_000),
        },
    );
    assert!(matches!(
        held_of("c-1")[0].status,
        HeldStatus::Flagged { .. }
    ));
    let refused =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| pay_out(&mut c, 1_995_000)));
    assert!(
        refused.is_err(),
        "a flagged entry is not paid out again automatically"
    );
}

#[test]
#[should_panic(expected = "SETTLE_REFUND_EXCEEDS_SENT")]
fn settle_refund_cannot_exceed_sent() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    let id = pay_out(&mut c, 1_995_000);
    forward_result(&mut c, id, true);
    ctx(RELAYER, vec![]);
    c.report_payout(
        "c-1".to_string(),
        0,
        id,
        PayoutOutcome::Refunded {
            amount: U128(1_995_001),
        },
    );
}

#[test]
fn settle_pays_owner_at_booking_after_transfer() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    set_destination(&mut c, BUYER, 0);
    ctx(BUYER, vec![]);
    c.set_settlement(
        "ethereum".to_string(),
        "0x2222222222222222222222222222222222222222".into(),
        U128(0),
    );
    book(&mut c, 2_000_000);
    // The token changes hands after booking.
    c.claims.get_mut("c-1").unwrap().owner_id = acc(BUYER);
    let held = held_of("c-1");
    assert_eq!(held[0].owner, acc(BIZ));
    pay_out(&mut c, 1_995_000);
    let sent = events("settle_sent");
    assert_eq!(sent[0]["owner"], BIZ);
    assert_eq!(sent[0]["chain"], "base");
    assert_eq!(sent[0]["address"], BASE_ADDR);
    // Only the owner at booking may release it to its Intents account.
    ctx(BUYER, vec![]);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.settle_release("c-1".into(), 0)
    }));
    assert!(r.is_err());
}

#[test]
fn settle_release_pays_owner_intents_account() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    ctx(BIZ, vec![]);
    c.clear_settlement();
    let id = c.settle_release("c-1".into(), 0);
    assert_eq!(po::get(id).unwrap().deposit_address, acc(BIZ));
    forward_result(&mut c, id, true);
    assert_eq!(
        held_of("c-1")[0].status,
        HeldStatus::Released { payout_id: id }
    );
    assert_eq!(c.claims.get("c-1").unwrap().lock, Lock::None);
    assert_eq!(last_seen(&c), 0);
}

// ── _payout.md ───────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "PAYOUT_MODULE_NOT_ENABLED")]
fn payout_only_from_enabled_module() {
    let _c = contract();
    po::payout_from(
        "payroll",
        "x#0".into(),
        acc("c-1.openrail.near"),
        ASSET.into(),
        U128(1),
        acc(DEPOSIT),
    );
}

#[test]
fn payout_only_allowlisted_relayer() {
    let mut c = contract();
    assert_eq!(c.payout_relayers(), vec![acc(RELAYER)]);
    ctx(BIZ, vec![]);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.set_payout_relayers(vec![acc(BIZ)])
    }));
    assert!(r.is_err(), "only root sets relayers");
    ctx(RELAYER, vec![]);
    po::require_relayer();
    ctx(BUYER, vec![]);
    assert!(std::panic::catch_unwind(po::require_relayer).is_err());
}

#[test]
#[should_panic(expected = "SETTLE_HELD_ASSET_SHORT")]
fn payout_amount_le_reserved() {
    // The module's reserve is the held entry, and the claim account must still show it.
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    c.claims
        .get_mut("c-1")
        .unwrap()
        .last_seen_balance
        .insert(ASSET.into(), U128(1_000_000));
    pay_out(&mut c, 1_995_000);
}

#[test]
fn payout_event_lists_deposit_address() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    let id = pay_out(&mut c, 1_995_000);
    let sent = events("payout_sent");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["payout_id"], id);
    assert_eq!(sent[0]["deposit_address"], DEPOSIT);
    assert_eq!(sent[0]["source"], "c-1.openrail.near");
    assert_eq!(sent[0]["amount_in"], "1995000");
    assert_eq!(events("settle_sent")[0]["deposit_address"], DEPOSIT);
}

#[test]
#[should_panic(expected = "SETTLE_CHAIN_REFUSED")]
fn payout_bnb_refused() {
    let _c = contract();
    validate_destination("bsc", BASE_ADDR);
}

#[test]
fn payout_batch_fits_gas() {
    // Static budget; the sandbox measurement replaces this (see staging README).
    let per = po::GAS_FOR_PAYOUT_FORWARD.as_tgas() + po::GAS_FOR_ON_PAYOUT.as_tgas();
    assert!(u64::from(po::MAX_PAYOUTS_PER_CALL) * per <= 300 * 8 / 10);
}

#[test]
fn settle_hold_spans_assets_by_capacity() {
    // Two settlement assets, 1.0 each: the held 1.995 must take 1.0 + 0.995, never 1.995 of one.
    let mut c = contract();
    const USDT: &str = "nep141:usdt.near";
    let claim = c.claims.get_mut("c-1").unwrap();
    claim.settlement_assets = vec![ASSET.to_string(), USDT.to_string()];
    set_destination(&mut c, BIZ, 0);
    c.claims.get_mut("c-1").unwrap().lock = Lock::Reconciling { since: 7 };
    let bytes = near_sdk::serde_json::to_vec(&vec![U128(1_000_000), U128(1_000_000)]).unwrap();
    ctx(ROOT, vec![PromiseResult::Successful(bytes)]);
    c.on_balances("c-1".to_string(), Lock::None, 7, None);
    let held = held_of("c-1");
    let mut per_asset: HashMap<String, u128> = HashMap::new();
    for entry in &held {
        *per_asset.entry(entry.asset.clone()).or_default() += entry.amount.0;
    }
    assert_eq!(held.iter().map(|e| e.amount.0).sum::<u128>(), 1_995_000);
    assert!(per_asset.values().all(|v| *v <= 1_000_000), "{per_asset:?}");
    assert_eq!(per_asset.len(), 2);
}

#[test]
#[should_panic(expected = "SETTLE_NOT_OWNER_AT_BOOKING")]
fn settle_release_only_owner_at_booking() {
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    c.claims.get_mut("c-1").unwrap().owner_id = acc(BUYER);
    ctx(BUYER, vec![]);
    c.settle_release("c-1".into(), 0);
}

#[test]
#[should_panic(expected = "NOT_IN_FLIGHT")]
fn settle_report_for_another_entry_panics() {
    // Payout 1 is out for entry 0; reporting it against entry 1 (still held) is refused.
    let mut c = contract();
    set_destination(&mut c, BIZ, 0);
    book(&mut c, 2_000_000);
    let id = pay_out(&mut c, 1_000_000);
    forward_result(&mut c, id, true);
    ctx(RELAYER, vec![]);
    c.report_payout(
        "c-1".into(),
        1,
        id,
        PayoutOutcome::Refunded {
            amount: U128(995_000),
        },
    );
}
