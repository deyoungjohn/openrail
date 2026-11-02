//! Pure unit tests for Openrail contract constants, state machine, and hook defaults (Blueprint 2.1, 2.3, 1.4).

use near_sdk::json_types::U128;
use near_sdk::AccountId;
use openrail::hooks::{
    dispatch_adjust_booking, dispatch_check_cancel, dispatch_check_credit,
    dispatch_check_credit_with, dispatch_check_transfer, dispatch_check_transfer_with,
    dispatch_check_writeoff, dispatch_in_motion, dispatch_kind_rules, dispatch_split_distribution,
    dispatch_split_distribution_with, BookingInput, CoreDefaultHook, Hook, Refusal,
};
use openrail::types::{
    Ack, AckScheme, Claim, Config, Debtor, Hex20, Hex32, HexBytes, Leg, Lock, Status,
};
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
        terms_hash: Hex32::new([1u8; 32]),
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
        settlement_assets: vec!["usdc.near".to_string()],
        booked_total: U128(0),
        distributed_total: U128(0),
        fee_total: U128(0),
        surplus: U128(0),
        credit_total: U128(0),
        credit_source: None,
        last_seen_balance: HashMap::new(),
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

// ──────────────────────────────────────────────
// Finding 1: Settlement Asset TokenId Round-Trip
// ──────────────────────────────────────────────

#[test]
fn test_routes_settlement_assets_roundtrip() {
    let routes_path = std::path::Path::new("../../fixtures/routes.json");
    let fallback_path = std::path::Path::new("fixtures/routes.json");
    let path = if routes_path.exists() {
        routes_path
    } else {
        fallback_path
    };
    let content = std::fs::read_to_string(path).expect("Failed to read fixtures/routes.json");
    let v: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_str(&content).expect("Valid JSON");
    let assets: Vec<String> = v["settlementAssets"]
        .as_array()
        .expect("settlementAssets array")
        .iter()
        .map(|s| s.as_str().expect("string").to_string())
        .collect();

    assert_eq!(assets.len(), 4);
    for a in &assets {
        assert!(
            a.contains(':'),
            "Intents token ID must contain colon: {}",
            a
        );
    }

    let config = Config {
        settlement_assets: assets.clone(),
        vault_code_hash: Hex32::new([7u8; 32]),
        fee_account: "fee.near".parse().unwrap(),
        watchers: vec!["watcher.near".parse().unwrap()],
        quote_writers: vec!["writer.near".parse().unwrap()],
        issuers: vec!["issuer.near".parse().unwrap()],
        issue_paused: false,
    };

    // JSON round-trip
    let json_str = near_sdk::serde_json::to_string(&config).expect("Serialize to JSON");
    let deserialized_json: Config =
        near_sdk::serde_json::from_str(&json_str).expect("Deserialize from JSON");
    assert_eq!(deserialized_json.settlement_assets, assets);
    assert_eq!(deserialized_json.fee_account, config.fee_account);
    assert_eq!(deserialized_json.vault_code_hash, config.vault_code_hash);
    assert_eq!(deserialized_json.watchers, config.watchers);
    assert_eq!(deserialized_json.quote_writers, config.quote_writers);
    assert_eq!(deserialized_json.issuers, config.issuers);
    assert_eq!(deserialized_json.issue_paused, config.issue_paused);

    // Borsh round-trip
    use near_sdk::borsh::{from_slice, to_vec};
    let borsh_bytes = to_vec(&config).expect("Serialize to Borsh");
    let deserialized_borsh: Config = from_slice(&borsh_bytes).expect("Deserialize from Borsh");
    assert_eq!(deserialized_borsh.settlement_assets, assets);
    assert_eq!(deserialized_borsh.fee_account, config.fee_account);
    assert_eq!(deserialized_borsh.vault_code_hash, config.vault_code_hash);
    assert_eq!(deserialized_borsh.watchers, config.watchers);
    assert_eq!(deserialized_borsh.quote_writers, config.quote_writers);
    assert_eq!(deserialized_borsh.issuers, config.issuers);
    assert_eq!(deserialized_borsh.issue_paused, config.issue_paused);
}

// ──────────────────────────────────────────────
// Finding 4: Hex Types 0x Serialization & Validation
// ──────────────────────────────────────────────

#[test]
fn test_hex_types_serialization_and_validation() {
    use near_sdk::borsh::{from_slice, to_vec};

    // Hex32
    let raw32 = [0xabu8; 32];
    let hex32 = Hex32::new(raw32);
    let json32 = near_sdk::serde_json::to_string(&hex32).unwrap();
    assert_eq!(json32, format!("\"0x{}\"", "ab".repeat(32)));
    let round32: Hex32 = near_sdk::serde_json::from_str(&json32).unwrap();
    assert_eq!(round32.0, raw32);

    let borsh32 = to_vec(&hex32).unwrap();
    assert_eq!(borsh32, raw32); // raw 32 bytes without prefix
    let round_borsh32: Hex32 = from_slice(&borsh32).unwrap();
    assert_eq!(round_borsh32.0, raw32);

    // Bad length Hex32
    assert!(Hex32::from_hex("0xabcd").is_err());
    assert!(near_sdk::serde_json::from_str::<Hex32>("\"0xabcd\"").is_err());
    // Bad hex chars
    assert!(Hex32::from_hex(&format!("0x{}zz", "ab".repeat(31))).is_err());

    // Hex20
    let raw20 = [0x42u8; 20];
    let hex20 = Hex20::new(raw20);
    let json20 = near_sdk::serde_json::to_string(&hex20).unwrap();
    assert_eq!(json20, format!("\"0x{}\"", "42".repeat(20)));
    let round20: Hex20 = near_sdk::serde_json::from_str(&json20).unwrap();
    assert_eq!(round20.0, raw20);
    let borsh20 = to_vec(&hex20).unwrap();
    assert_eq!(borsh20, raw20);
    let round_borsh20: Hex20 = from_slice(&borsh20).unwrap();
    assert_eq!(round_borsh20.0, raw20);

    // Bad length Hex20
    assert!(Hex20::from_hex("0x1234").is_err());
    assert!(near_sdk::serde_json::from_str::<Hex20>("\"0x1234\"").is_err());

    // HexBytes
    let raw_bytes = vec![0x01, 0x02, 0x03, 0xff];
    let hex_bytes = HexBytes::new(raw_bytes.clone());
    let json_bytes = near_sdk::serde_json::to_string(&hex_bytes).unwrap();
    assert_eq!(json_bytes, "\"0x010203ff\"");
    let round_bytes: HexBytes = near_sdk::serde_json::from_str(&json_bytes).unwrap();
    assert_eq!(round_bytes.0, raw_bytes);
    let borsh_bytes = to_vec(&hex_bytes).unwrap();
    let round_borsh_bytes: HexBytes = from_slice(&borsh_bytes).unwrap();
    assert_eq!(round_borsh_bytes.0, raw_bytes);

    // Odd length HexBytes
    assert!(HexBytes::from_hex("0x123").is_err());
    assert!(near_sdk::serde_json::from_str::<HexBytes>("\"0x123\"").is_err());
}

// ──────────────────────────────────────────────
// Finding 2: Composed Hook Laws & Hostile Hooks
// ──────────────────────────────────────────────

struct HostilePermitHook;
impl Hook for HostilePermitHook {
    fn check_transfer(&self, _claim: &Claim, _receiver: &AccountId) -> Result<(), Refusal> {
        Ok(()) // Tries to permit everything
    }
    fn check_credit(&self, _claim: &Claim, _source: u8) -> Result<(), Refusal> {
        Ok(()) // Tries to permit secondary credit source
    }
}

struct HostileRefusalHook;
impl Hook for HostileRefusalHook {
    fn check_transfer(&self, _claim: &Claim, _receiver: &AccountId) -> Result<(), Refusal> {
        Err(Refusal::new("module blocked transfer"))
    }
}

struct HostileStealingHook;
impl Hook for HostileStealingHook {
    fn split_distribution(&self, claim: &Claim, net: U128) -> Vec<Leg> {
        // Attempts to steal funds by returning legs that sum to more than net!
        vec![Leg::pay(claim.owner_id.clone(), U128(net.0 + 1_000_000))]
    }
}

#[test]
fn test_module_cannot_permit_core_refusal() {
    let mut claim = sample_claim();
    claim.credit_source = Some(1); // source 1 already locked in

    // 1. Core single-source rule refusal cannot be overridden by module returning Ok(())
    let hostile_hook = HostilePermitHook;
    let res = dispatch_check_credit_with(&[&hostile_hook], &claim, 2);
    assert!(
        res.is_err(),
        "Module returning Ok must NOT permit what core refuses (single credit source)"
    );

    // 2. Module refusal must block transfer even if another module returns Ok(())
    let refusing_hook = HostileRefusalHook;
    let receiver: AccountId = "carol.near".parse().unwrap();
    let res = dispatch_check_transfer_with(&[&refusing_hook, &hostile_hook], &claim, &receiver);
    assert!(
        res.is_err(),
        "Module refusal must win over permissive module"
    );
    assert_eq!(res.unwrap_err().reason, "module blocked transfer");
}

#[test]
fn test_legs_sum_to_net() {
    let claim = sample_claim();
    let net = U128(997_500);

    // Hostile hook attempts to emit legs summing to net + 1_000_000
    let stealing_hook = HostileStealingHook;
    let legs = dispatch_split_distribution_with(&[&stealing_hook], &claim, net);

    // Laws require fallback to core default [Leg::Pay(owner_id, net)]
    assert_eq!(
        legs.len(),
        1,
        "Must fall back to core default on conservation violation"
    );
    assert_eq!(legs[0].amount(), net);
    assert_eq!(
        legs[0].receiver(),
        Some(&claim.owner_id),
        "Recipient must be claim owner"
    );
}
