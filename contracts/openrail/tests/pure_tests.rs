//! Pure unit tests for Openrail contract constants, state machine, and hook defaults (Blueprint 2.1, 2.3, 1.4).

use near_sdk::json_types::U128;
use near_sdk::AccountId;
use openrail::hooks::{
    dispatch_adjust_booking, dispatch_check_cancel, dispatch_check_credit, dispatch_check_transfer,
    dispatch_check_writeoff, dispatch_in_motion, dispatch_kind_rules, dispatch_split_distribution,
    BookingInput, CoreDefaultHook, Hook,
};
use openrail::types::{Ack, AckScheme, Claim, Debtor, Leg, Lock, Status};
use openrail::{
    ERR_RULE_1_LOCK, ERR_RULE_2_STATUS, ERR_RULE_3_ACK_REQUIRED, ERR_RULE_4_ASSIGNMENT_DOC,
    ERR_RULE_5_RECEIVER_NOT_CLAIM, ERR_RULE_6_YOCTO_DEPOSIT, ERR_RULE_7_NOT_SELLABLE,
    ERR_RULE_8_HOOK_REFUSED, FEE_BPS, STORAGE_KEY_CONFIG, STORAGE_PREFIX_CLAIMS,
    STORAGE_PREFIX_OWNER_INDEX, STORAGE_PREFIX_PAYMENT_LOG, STORAGE_PREFIX_STORAGE_CREDIT,
    STORAGE_PREFIX_TOKEN_METADATA, STORAGE_PREFIX_UNDISTRIBUTED,
};
use std::collections::HashMap;

// ──────────────────────────────────────────────
// Canonical Constants (Blueprint 2.1, 1.4)
// ──────────────────────────────────────────────

#[test]
fn test_canonical_fee_is_25_bps() {
    assert_eq!(FEE_BPS, 25, "Protocol fee must be canonically 25 bps");

    // Fee calculation test: floor(payment * 25 / 10_000)
    let payment: u128 = 1_000_000; // $1.00 USDC (6 decimals)
    let fee = payment * FEE_BPS / 10_000;
    assert_eq!(fee, 2500); // 0.0025 USDC = 25 bps

    let small_payment: u128 = 399;
    let fee_small = small_payment * FEE_BPS / 10_000;
    assert_eq!(fee_small, 0); // floor behavior
}

#[test]
fn test_storage_prefixes() {
    assert_eq!(STORAGE_PREFIX_CLAIMS, b"c:");
    assert_eq!(STORAGE_PREFIX_OWNER_INDEX, b"o:");
    assert_eq!(STORAGE_PREFIX_TOKEN_METADATA, b"t:");
    assert_eq!(STORAGE_PREFIX_PAYMENT_LOG, b"l:");
    assert_eq!(STORAGE_PREFIX_UNDISTRIBUTED, b"u:");
    assert_eq!(STORAGE_PREFIX_STORAGE_CREDIT, b"s:");
    assert_eq!(STORAGE_KEY_CONFIG, b"cfg");
}

#[test]
fn test_rule_panic_messages_carry_rule_numbers() {
    assert!(ERR_RULE_1_LOCK.starts_with("Rule 1:"));
    assert!(ERR_RULE_2_STATUS.starts_with("Rule 2:"));
    assert!(ERR_RULE_3_ACK_REQUIRED.starts_with("Rule 3:"));
    assert!(ERR_RULE_4_ASSIGNMENT_DOC.starts_with("Rule 4:"));
    assert!(ERR_RULE_5_RECEIVER_NOT_CLAIM.starts_with("Rule 5:"));
    assert!(ERR_RULE_6_YOCTO_DEPOSIT.starts_with("Rule 6:"));
    assert!(ERR_RULE_7_NOT_SELLABLE.starts_with("Rule 7:"));
    assert!(ERR_RULE_8_HOOK_REFUSED.starts_with("Rule 8:"));
}

// ──────────────────────────────────────────────
// Status Transition Table as Data (Blueprint 2.3)
// ──────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
enum TransitionAction {
    Issue,
    ReconcilePartial,
    ReconcileFull,
    ApplyCreditFull,
    Cancel,
    Close,
    CloseWriteoff,
}

fn is_valid_transition(from: Option<Status>, to: Status, action: &TransitionAction) -> bool {
    matches!(
        (from, to, action),
        (None, Status::Issued, TransitionAction::Issue)
            | (
                Some(Status::Issued),
                Status::PartiallyPaid,
                TransitionAction::ReconcilePartial
            )
            | (
                Some(Status::Issued),
                Status::Paid,
                TransitionAction::ReconcileFull
            )
            | (
                Some(Status::Issued),
                Status::Cancelled,
                TransitionAction::Cancel
            )
            | (
                Some(Status::PartiallyPaid),
                Status::Paid,
                TransitionAction::ReconcileFull
            )
            | (
                Some(Status::PartiallyPaid),
                Status::Paid,
                TransitionAction::ApplyCreditFull
            )
            | (
                Some(Status::PartiallyPaid),
                Status::Closed,
                TransitionAction::CloseWriteoff
            )
            | (Some(Status::Paid), Status::Closed, TransitionAction::Close)
    )
}

#[test]
fn test_status_transition_table() {
    // Valid transitions
    assert!(is_valid_transition(
        None,
        Status::Issued,
        &TransitionAction::Issue
    ));
    assert!(is_valid_transition(
        Some(Status::Issued),
        Status::PartiallyPaid,
        &TransitionAction::ReconcilePartial
    ));
    assert!(is_valid_transition(
        Some(Status::Issued),
        Status::Paid,
        &TransitionAction::ReconcileFull
    ));
    assert!(is_valid_transition(
        Some(Status::Issued),
        Status::Cancelled,
        &TransitionAction::Cancel
    ));
    assert!(is_valid_transition(
        Some(Status::PartiallyPaid),
        Status::Paid,
        &TransitionAction::ReconcileFull
    ));
    assert!(is_valid_transition(
        Some(Status::PartiallyPaid),
        Status::Paid,
        &TransitionAction::ApplyCreditFull
    ));
    assert!(is_valid_transition(
        Some(Status::PartiallyPaid),
        Status::Closed,
        &TransitionAction::CloseWriteoff
    ));
    assert!(is_valid_transition(
        Some(Status::Paid),
        Status::Closed,
        &TransitionAction::Close
    ));

    // Terminal state checks: Cancelled and Closed can never transition to anything
    let all_statuses = [
        Status::Issued,
        Status::PartiallyPaid,
        Status::Paid,
        Status::Cancelled,
        Status::Closed,
    ];
    let all_actions = [
        TransitionAction::Issue,
        TransitionAction::ReconcilePartial,
        TransitionAction::ReconcileFull,
        TransitionAction::ApplyCreditFull,
        TransitionAction::Cancel,
        TransitionAction::Close,
        TransitionAction::CloseWriteoff,
    ];

    for terminal in [Status::Cancelled, Status::Closed] {
        for target in all_statuses {
            for action in &all_actions {
                assert!(
                    !is_valid_transition(Some(terminal), target, action),
                    "Terminal state {:?} must not transition to {:?}",
                    terminal,
                    target
                );
            }
        }
    }

    // Paid cannot transition back to Issued or PartiallyPaid
    for invalid in [Status::Issued, Status::PartiallyPaid] {
        for action in &all_actions {
            assert!(
                !is_valid_transition(Some(Status::Paid), invalid, action),
                "Paid cannot transition to {:?}",
                invalid
            );
        }
    }
}

// ──────────────────────────────────────────────
// Hook Defaults (Blueprint 1.4: hooks_default_is_identity)
// ──────────────────────────────────────────────

fn sample_claim() -> Claim {
    Claim {
        token_id: "c-1".to_string(),
        kind: 0,
        issuer_id: "alice.near".parse().unwrap(),
        owner_id: "alice.near".parse().unwrap(),
        claim_account: "c-1.openrail.near".parse().unwrap(),
        debtor: Some(Debtor::Near("bob.near".parse().unwrap())),
        terms_hash: [1u8; 32],
        amount_due: U128(1_000_000),
        due_date: 1735689600,
        ack: Some(Ack {
            scheme: AckScheme::Near {
                account: "bob.near".parse().unwrap(),
            },
            block: 100,
        }),
        status: Status::Issued,
        lock: Lock::None,
        settlement_assets: vec!["usdc.near".parse().unwrap()],
        booked_total: U128(0),
        distributed_total: U128(0),
        fee_total: U128(0),
        surplus: U128(0),
        credit_total: U128(0),
        credit_source: None,
        last_seen_balance: HashMap::new(),
        undistributed: Vec::new(),
        assignment_doc_hash: None,
        created_block: 50,
    }
}

#[test]
fn test_hooks_default_is_identity() {
    let claim = sample_claim();
    let hook = CoreDefaultHook;

    // 1. check_transfer defaults to Ok
    let receiver: AccountId = "carol.near".parse().unwrap();
    assert!(hook.check_transfer(&claim, &receiver).is_ok());
    assert!(dispatch_check_transfer(&claim, &receiver).is_ok());

    // 2. check_cancel defaults to Ok
    assert!(hook.check_cancel(&claim).is_ok());
    assert!(dispatch_check_cancel(&claim).is_ok());

    // 3. check_writeoff defaults to Ok
    assert!(hook.check_writeoff(&claim).is_ok());
    assert!(dispatch_check_writeoff(&claim).is_ok());

    // 4. adjust_booking defaults to min(delta, outstanding), credit 0
    let input = BookingInput {
        delta: U128(400_000),
        outstanding: U128(1_000_000),
        now: 1735690000,
    };
    let adjust = hook.adjust_booking(&claim, input.clone());
    assert_eq!(adjust.payment, U128(400_000));
    assert_eq!(adjust.credit, U128(0));
    assert_eq!(
        dispatch_adjust_booking(&claim, input).payment,
        U128(400_000)
    );

    // When delta > outstanding
    let input_over = BookingInput {
        delta: U128(1_500_000),
        outstanding: U128(1_000_000),
        now: 1735690000,
    };
    let adjust_over = hook.adjust_booking(&claim, input_over);
    assert_eq!(adjust_over.payment, U128(1_000_000));
    assert_eq!(adjust_over.credit, U128(0));

    // 5. split_distribution defaults to [Leg::Pay(owner_id, net)]
    let net = U128(997_500);
    let legs = hook.split_distribution(&claim, net);
    assert_eq!(legs.len(), 1);
    match &legs[0] {
        Leg::Pay {
            receiver,
            amount,
            asset,
        } => {
            assert_eq!(receiver, &claim.owner_id);
            assert_eq!(*amount, net);
            assert!(asset.is_none());
        }
        _ => panic!("Expected Leg::Pay"),
    }
    let dispatched_legs = dispatch_split_distribution(&claim, net);
    assert_eq!(dispatched_legs.len(), 1);
    assert_eq!(dispatched_legs[0].amount(), net);

    // 6. check_credit defaults to Ok
    assert!(hook.check_credit(&claim, 1).is_ok());
    assert!(dispatch_check_credit(&claim, 1).is_ok());

    // 7. in_motion defaults to false
    assert!(!hook.in_motion(&claim));
    assert!(!dispatch_in_motion(&claim));

    // 8. kind_rules default for kind 0 (Invoice)
    let rules = hook.kind_rules(0);
    assert!(rules.ack_required_for_sale);
    assert!(rules.sellable);
    assert_eq!(rules.quote_deadline, 3600);
    assert!(!rules.debtor_optional);

    let dispatched_rules = dispatch_kind_rules(0);
    assert_eq!(rules, dispatched_rules);
}
