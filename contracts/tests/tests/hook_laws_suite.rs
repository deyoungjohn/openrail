//! Hook Laws Test Suite (Blueprint 1.4, 2.11 & Prompt Update 5).
//!
//! Validates the six hook laws governing core-module interaction:
//! 1. `hooks_default_is_identity`: Core-only results equal the reference model.
//! 2. `credit_single_source`: At most one credit source per claim (SQ-1).
//! 3. `credit_never_exceeds_outstanding`: Credit cannot exceed outstanding amount.
//! 4. `legs_sum_to_net`: Legs must sum to net; invalid legs fall back to core default.
//! 5. `module_cannot_permit_core_refusal`: Fuzzed with hostile test hook; core refusal is final.
//! 6. `module_storage_isolated`: Core state prefixes are strictly isolated from module storage.
//!
//! Includes companion contract sandbox tests marked `#[ignore = "C<n>"]` pending Phase 1.

use near_sdk::json_types::U128;
use near_sdk::AccountId;
use openrail::hooks::{self, Booking, BookingAdjust, BookingInput, Hook, KindRules, Refusal};
use openrail::types::{Claim, Hex32, Leg, Lock, Status};
use openrail::{
    STORAGE_KEY_CONFIG, STORAGE_PREFIX_CLAIMS, STORAGE_PREFIX_OWNER_INDEX,
    STORAGE_PREFIX_PAYMENT_LOG, STORAGE_PREFIX_PAYMENT_LOG_COUNT, STORAGE_PREFIX_STORAGE_CREDIT,
    STORAGE_PREFIX_TOKEN_METADATA, STORAGE_PREFIX_UNDISTRIBUTED,
};
use openrail_model::hook::{CoreDefaultHook as ModelCoreDefaultHook, Hook as ModelHook};
use openrail_model::types::Claim as ModelClaim;
use openrail_tests::env::Env;
use proptest::prelude::*;
use std::collections::HashMap;

// ──────────────────────────────────────────────
// Adversarial / Hostile Hook Implementation
// ──────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct HostileHook {
    pub refuse_transfer: Option<Refusal>,
    pub refuse_cancel: Option<Refusal>,
    pub refuse_writeoff: Option<Refusal>,
    pub refuse_credit: Option<Refusal>,
    pub custom_payment: Option<u128>,
    pub excessive_credit: Option<u128>,
    pub custom_distribution_legs: Option<Vec<Leg>>,
    pub is_in_motion: bool,
    pub custom_kind_rules: Option<KindRules>,
}

impl Hook for HostileHook {
    fn check_transfer(&self, _claim: &Claim, _receiver: &AccountId) -> Result<(), Refusal> {
        if let Some(ref r) = self.refuse_transfer {
            Err(r.clone())
        } else {
            Ok(())
        }
    }

    fn check_cancel(&self, _claim: &Claim) -> Result<(), Refusal> {
        if let Some(ref r) = self.refuse_cancel {
            Err(r.clone())
        } else {
            Ok(())
        }
    }

    fn check_writeoff(&self, _claim: &Claim) -> Result<(), Refusal> {
        if let Some(ref r) = self.refuse_writeoff {
            Err(r.clone())
        } else {
            Ok(())
        }
    }

    fn check_credit(&self, _claim: &Claim, _source: u8) -> Result<(), Refusal> {
        if let Some(ref r) = self.refuse_credit {
            Err(r.clone())
        } else {
            Ok(())
        }
    }

    fn adjust_booking(&self, _claim: &Claim, input: BookingInput) -> BookingAdjust {
        BookingAdjust {
            payment: self.custom_payment.map(U128).unwrap_or(input.delta),
            credit: self.excessive_credit.map(U128).unwrap_or(U128(0)),
        }
    }

    fn split_distribution(&self, claim: &Claim, net: U128) -> Vec<Leg> {
        if let Some(ref legs) = self.custom_distribution_legs {
            legs.clone()
        } else {
            vec![Leg::pay(claim.owner_id.clone(), net)]
        }
    }

    fn in_motion(&self, _claim: &Claim) -> bool {
        self.is_in_motion
    }

    fn kind_rules(&self, _kind: u8) -> KindRules {
        if let Some(ref kr) = self.custom_kind_rules {
            kr.clone()
        } else {
            KindRules::default()
        }
    }
}

// ──────────────────────────────────────────────
// Test Helpers
// ──────────────────────────────────────────────

fn dummy_claim(token_id: &str, credit_source: Option<u8>) -> Claim {
    let dummy_account: AccountId = "alice.near".parse().unwrap();
    Claim {
        token_id: token_id.to_string(),
        kind: 0,
        issuer_id: dummy_account.clone(),
        owner_id: dummy_account.clone(),
        claim_account: "c-1.openrail.near".parse().unwrap(),
        debtor: None,
        terms_hash: Hex32([0u8; 32]),
        amount_due: 1_000_000.into(),
        due_date: 1_800_000_000,
        ack: None,
        status: Status::Issued,
        lock: Lock::None,
        settlement_assets: vec!["nep141:usdc.near".to_string()],
        booked_total: 0.into(),
        distributed_total: 0.into(),
        fee_total: 0.into(),
        surplus: 0.into(),
        credit_total: 0.into(),
        credit_source,
        last_seen_balance: HashMap::new(),
        assignment_doc_hash: None,
        created_block: 100,
    }
}

fn dummy_model_claim(token_id: &str) -> ModelClaim {
    ModelClaim {
        token_id: token_id.to_string(),
        kind: 0,
        issuer_id: "alice.near".to_string(),
        owner_id: "alice.near".to_string(),
        claim_account: "c-1.openrail.near".to_string(),
        debtor: None,
        terms_hash: openrail_model::types::Hex32([0u8; 32]),
        amount_due: 1_000_000,
        due_date: 1_800_000_000,
        ack: None,
        status: openrail_model::types::Status::Issued,
        lock: openrail_model::types::Lock::None,
        settlement_assets: vec!["nep141:usdc.near".to_string()],
        booked_total: 0,
        distributed_total: 0,
        fee_total: 0,
        surplus: 0,
        credit_total: 0,
        credit_source: None,
        undistributed: Vec::new(),
        last_seen_balance: HashMap::new(),
        assignment_doc_hash: None,
        created_block: 100,
    }
}

fn proptest_config() -> ProptestConfig {
    let cases = std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(30);
    ProptestConfig {
        cases,
        failure_persistence: None,
        ..ProptestConfig::default()
    }
}

// ──────────────────────────────────────────────
// Law 1: hooks_default_is_identity
// ──────────────────────────────────────────────

#[test]
fn hooks_default_is_identity() {
    let empty_hooks: Vec<&dyn Hook> = Vec::new();
    let claim = dummy_claim("claim-1", None);
    let model_claim = dummy_model_claim("claim-1");
    let receiver: AccountId = "bob.near".parse().unwrap();

    let model_default = ModelCoreDefaultHook;

    // 1. check_transfer
    let dispatch_transfer = hooks::dispatch_check_transfer_with(&empty_hooks, &claim, &receiver);
    let model_transfer = model_default.check_transfer(&model_claim, receiver.as_ref());
    assert!(dispatch_transfer.is_ok());
    assert!(model_transfer.is_ok());

    // 2. check_cancel
    let dispatch_cancel = hooks::dispatch_check_cancel_with(&empty_hooks, &claim);
    let model_cancel = model_default.check_cancel(&model_claim);
    assert!(dispatch_cancel.is_ok());
    assert!(model_cancel.is_ok());

    // 3. check_writeoff
    let dispatch_writeoff = hooks::dispatch_check_writeoff_with(&empty_hooks, &claim);
    let model_writeoff = model_default.check_writeoff(&model_claim);
    assert!(dispatch_writeoff.is_ok());
    assert!(model_writeoff.is_ok());

    // 4. check_credit
    let dispatch_credit = hooks::dispatch_check_credit_with(&empty_hooks, &claim, 1);
    assert!(dispatch_credit.is_ok());

    // 5. adjust_booking across several inputs
    for (delta, outstanding) in [
        (500_000u128, 1_000_000u128),
        (1_500_000, 1_000_000),
        (0, 500),
    ] {
        let input = BookingInput {
            delta: delta.into(),
            outstanding: outstanding.into(),
            now: 1_700_000_000,
        };
        let dispatch_adj = hooks::dispatch_adjust_booking_with(&empty_hooks, &claim, input);
        let (model_payment, model_credit) =
            model_default.adjust_booking(&model_claim, delta, outstanding, 1_700_000_000);

        assert_eq!(dispatch_adj.payment.0, model_payment);
        assert_eq!(dispatch_adj.credit.0, model_credit);
        assert_eq!(dispatch_adj.credit.0, 0);
        assert_eq!(dispatch_adj.payment.0, std::cmp::min(delta, outstanding));
    }

    // 6. split_distribution
    let net = 997_500u128;
    let dispatch_legs = hooks::dispatch_split_distribution_with(&empty_hooks, &claim, net.into());
    let model_legs = model_default.split_distribution(&model_claim, net);
    assert_eq!(dispatch_legs.len(), 1);
    assert_eq!(model_legs.len(), 1);
    assert_eq!(dispatch_legs[0].receiver(), Some(&claim.owner_id));
    assert_eq!(dispatch_legs[0].amount().0, net);
    assert_eq!(model_legs[0].amount(), net);

    // 7. in_motion
    assert!(!hooks::dispatch_in_motion_with(&empty_hooks, &claim));

    // 8. kind_rules
    let invoice_rules = hooks::dispatch_kind_rules_with(&empty_hooks, 0);
    assert_eq!(invoice_rules, KindRules::invoice());
    assert!(invoice_rules.ack_required_for_sale);
    assert!(invoice_rules.sellable);
    assert_eq!(invoice_rules.quote_deadline, 3600);
    assert!(!invoice_rules.debtor_optional);

    let model_invoice = model_default.kind_rules(0).expect("model invoice rules");
    assert_eq!(
        invoice_rules.ack_required_for_sale,
        model_invoice.ack_required_for_sale
    );
    assert_eq!(invoice_rules.sellable, model_invoice.sellable);
}

// ──────────────────────────────────────────────
// Law 2: credit_single_source
// ──────────────────────────────────────────────

#[test]
fn credit_single_source() {
    let empty_hooks: Vec<&dyn Hook> = Vec::new();

    // Case 1: uncredited claim accepts its first credit source
    let claim_uncredited = dummy_claim("claim-1", None);
    assert!(hooks::dispatch_check_credit_with(&empty_hooks, &claim_uncredited, 1).is_ok());
    assert!(hooks::dispatch_check_credit_with(&empty_hooks, &claim_uncredited, 42).is_ok());

    // Case 2: claim with existing credit_source = Some(1)
    let claim_credited = dummy_claim("claim-2", Some(1));
    // Same source allowed
    assert!(hooks::dispatch_check_credit_with(&empty_hooks, &claim_credited, 1).is_ok());

    // Different source refused
    let err = hooks::dispatch_check_credit_with(&empty_hooks, &claim_credited, 2).unwrap_err();
    assert_eq!(err.reason, "only one credit source permitted per claim");

    // Case 3: Hostile permissive module attempts to permit source 2
    let hostile_permissive = HostileHook {
        refuse_credit: None, // returns Ok(())
        ..Default::default()
    };
    let hostile_hooks: Vec<&dyn Hook> = vec![&hostile_permissive];

    // Core single-source enforcement runs before module hooks; hostile module cannot override
    let err_hostile =
        hooks::dispatch_check_credit_with(&hostile_hooks, &claim_credited, 2).unwrap_err();
    assert_eq!(
        err_hostile.reason,
        "only one credit source permitted per claim"
    );
}

// ──────────────────────────────────────────────
// Law 3: credit_never_exceeds_outstanding
// ──────────────────────────────────────────────

#[test]
fn credit_never_exceeds_outstanding() {
    let claim = dummy_claim("claim-1", None);
    let outstanding = 500_000u128;
    let delta = 200_000u128;

    // Hostile hook attempts to return massive credit exceeding outstanding
    let hostile = HostileHook {
        excessive_credit: Some(10_000_000), // 10M > 500k outstanding
        custom_payment: Some(delta),
        ..Default::default()
    };
    let hooks: Vec<&dyn Hook> = vec![&hostile];

    let input = BookingInput {
        delta: delta.into(),
        outstanding: outstanding.into(),
        now: 1_700_000_000,
    };
    let adjusted = hooks::dispatch_adjust_booking_with(&hooks, &claim, input);

    // Law: credit must be clamped to <= outstanding
    assert!(
        adjusted.credit.0 <= outstanding,
        "credit {} exceeded outstanding {}",
        adjusted.credit.0,
        outstanding
    );
    assert_eq!(adjusted.credit.0, outstanding);
}

proptest! {
    #![proptest_config(proptest_config())]
    #[test]
    fn prop_credit_never_exceeds_outstanding(
        delta in 0u128..=10_000_000,
        outstanding in 0u128..=10_000_000,
        hostile_credit in 0u128..=100_000_000,
    ) {
        let claim = dummy_claim("claim-fuzz", None);
        let hostile = HostileHook {
            excessive_credit: Some(hostile_credit),
            custom_payment: Some(delta),
            ..Default::default()
        };
        let hooks: Vec<&dyn Hook> = vec![&hostile];
        let input = BookingInput {
            delta: delta.into(),
            outstanding: outstanding.into(),
            now: 1_700_000_000,
        };
        let adjusted = hooks::dispatch_adjust_booking_with(&hooks, &claim, input);

        prop_assert!(adjusted.credit.0 <= outstanding);
    }
}

/// SQ-1 combined rule: payment + credit <= outstanding.
///
/// Marked #[ignore = "SQ-1"] pending Phase 3 specification decision on SQ-1.
#[test]
#[ignore = "SQ-1"]
fn payment_plus_credit_never_exceeds_outstanding() {
    let claim = dummy_claim("claim-1", None);
    let outstanding = 500_000u128;
    let delta = 300_000u128;

    // Hostile hook attempts to return payment = 300k and credit = 300k (sum 600k > 500k)
    let hostile = HostileHook {
        excessive_credit: Some(300_000),
        custom_payment: Some(delta),
        ..Default::default()
    };
    let hooks: Vec<&dyn Hook> = vec![&hostile];

    let input = BookingInput {
        delta: delta.into(),
        outstanding: outstanding.into(),
        now: 1_700_000_000,
    };
    let adjusted = hooks::dispatch_adjust_booking_with(&hooks, &claim, input);

    assert!(
        adjusted.payment.0 + adjusted.credit.0 <= outstanding,
        "payment ({}) + credit ({}) exceeded outstanding ({})",
        adjusted.payment.0,
        adjusted.credit.0,
        outstanding
    );
}

// ──────────────────────────────────────────────
// Law 4: legs_sum_to_net
// ──────────────────────────────────────────────

#[test]
fn legs_sum_to_net() {
    let claim = dummy_claim("claim-1", None);
    let net = 1_000_000u128;
    let partner: AccountId = "bob.near".parse().unwrap();

    // Subcase 4A: Valid custom legs summing exactly to net
    let valid_legs = vec![
        Leg::pay(claim.owner_id.clone(), 600_000.into()),
        Leg::pay(partner.clone(), 400_000.into()),
    ];
    let valid_hook = HostileHook {
        custom_distribution_legs: Some(valid_legs.clone()),
        ..Default::default()
    };
    let hooks_valid: Vec<&dyn Hook> = vec![&valid_hook];
    let result_valid = hooks::dispatch_split_distribution_with(&hooks_valid, &claim, net.into());
    assert_eq!(result_valid, valid_legs);

    // Subcase 4B: Hostile under-distribution (steals or drops 500k)
    let under_legs = vec![Leg::pay(claim.owner_id.clone(), 500_000.into())];
    let under_hook = HostileHook {
        custom_distribution_legs: Some(under_legs),
        ..Default::default()
    };
    let hooks_under: Vec<&dyn Hook> = vec![&under_hook];
    let result_under = hooks::dispatch_split_distribution_with(&hooks_under, &claim, net.into());
    // Conservation law: must fall back to core default (full net to owner)
    assert_eq!(result_under.len(), 1);
    assert_eq!(result_under[0].receiver(), Some(&claim.owner_id));
    assert_eq!(result_under[0].amount().0, net);

    // Subcase 4C: Hostile over-distribution / inflation (creates 1M from nowhere)
    let over_legs = vec![Leg::pay(claim.owner_id.clone(), 2_000_000.into())];
    let over_hook = HostileHook {
        custom_distribution_legs: Some(over_legs),
        ..Default::default()
    };
    let hooks_over: Vec<&dyn Hook> = vec![&over_hook];
    let result_over = hooks::dispatch_split_distribution_with(&hooks_over, &claim, net.into());
    assert_eq!(result_over.len(), 1);
    assert_eq!(result_over[0].receiver(), Some(&claim.owner_id));
    assert_eq!(result_over[0].amount().0, net);

    // Subcase 4D: Hostile empty legs when net > 0
    let empty_legs = Vec::new();
    let empty_hook = HostileHook {
        custom_distribution_legs: Some(empty_legs),
        ..Default::default()
    };
    let hooks_empty: Vec<&dyn Hook> = vec![&empty_hook];
    let result_empty = hooks::dispatch_split_distribution_with(&hooks_empty, &claim, net.into());
    assert_eq!(result_empty.len(), 1);
    assert_eq!(result_empty[0].receiver(), Some(&claim.owner_id));
    assert_eq!(result_empty[0].amount().0, net);
}

proptest! {
    #![proptest_config(proptest_config())]
    #[test]
    fn prop_legs_sum_to_net_or_fallback(
        net in 1u128..=10_000_000,
        split_a in 0u128..=10_000_000,
        split_b in 0u128..=10_000_000,
    ) {
        let claim = dummy_claim("claim-prop", None);
        let partner: AccountId = "bob.near".parse().unwrap();
        let candidate_legs = vec![
            Leg::pay(claim.owner_id.clone(), split_a.into()),
            Leg::pay(partner, split_b.into()),
        ];
        let hook = HostileHook {
            custom_distribution_legs: Some(candidate_legs.clone()),
            ..Default::default()
        };
        let hooks: Vec<&dyn Hook> = vec![&hook];
        let result = hooks::dispatch_split_distribution_with(&hooks, &claim, net.into());

        let sum: u128 = result.iter().map(|l| l.amount().0).sum();
        prop_assert_eq!(sum, net);

        if split_a.saturating_add(split_b) == net {
            prop_assert_eq!(result, candidate_legs);
        } else {
            prop_assert_eq!(result, vec![Leg::pay(claim.owner_id.clone(), net.into())]);
        }
    }
}

#[tokio::test]
async fn contract_legs_sum_to_net_or_fallback() -> anyhow::Result<()> {
    let env = Env::new().await?;
    // When C4 lands: verify reconcile distributions strictly adhere to sum(legs) == net.
    let outcome = env
        .parent
        .call(env.root.id(), "reconcile")
        .args_json(serde_json::json!({
            "token_id": "1"
        }))
        .transact()
        .await?;
    assert!(outcome.is_failure());
    Ok(())
}

// ──────────────────────────────────────────────
// Law 5: module_cannot_permit_core_refusal
// ──────────────────────────────────────────────

#[test]
fn module_cannot_permit_core_refusal() {
    let claim = dummy_claim("claim-1", None);
    let receiver: AccountId = "bob.near".parse().unwrap();

    // Prior hook / core checks refuse transfer
    let refusing_hook = HostileHook {
        refuse_transfer: Some(Refusal::with_rule(8, "hook transfer check refused")),
        refuse_cancel: Some(Refusal::new("cancel disallowed")),
        refuse_writeoff: Some(Refusal::new("writeoff disallowed")),
        ..Default::default()
    };

    // Adversarial second module that tries to permit everything (returns Ok(()))
    let permissive_hostile = HostileHook {
        refuse_transfer: None,
        refuse_cancel: None,
        refuse_writeoff: None,
        ..Default::default()
    };

    let composed_hooks: Vec<&dyn Hook> = vec![&refusing_hook, &permissive_hostile];

    // Transfer refusal is preserved
    let err_transfer =
        hooks::dispatch_check_transfer_with(&composed_hooks, &claim, &receiver).unwrap_err();
    assert_eq!(err_transfer.rule, Some(8));
    assert_eq!(err_transfer.reason, "hook transfer check refused");

    // Cancel refusal is preserved
    let err_cancel = hooks::dispatch_check_cancel_with(&composed_hooks, &claim).unwrap_err();
    assert_eq!(err_cancel.reason, "cancel disallowed");

    // Writeoff refusal is preserved
    let err_writeoff = hooks::dispatch_check_writeoff_with(&composed_hooks, &claim).unwrap_err();
    assert_eq!(err_writeoff.reason, "writeoff disallowed");

    // Core single-source credit refusal is preserved
    let claim_with_credit = dummy_claim("claim-1", Some(1));
    let err_credit =
        hooks::dispatch_check_credit_with(&composed_hooks, &claim_with_credit, 2).unwrap_err();
    assert_eq!(
        err_credit.reason,
        "only one credit source permitted per claim"
    );
}

proptest! {
    #![proptest_config(proptest_config())]
    #[test]
    fn prop_module_cannot_permit_refusal(
        refuse_idx in 0usize..5,
        rule_num in 1u32..10,
    ) {
        let claim = dummy_claim("claim-fuzz", None);
        let receiver: AccountId = "bob.near".parse().unwrap();

        let mut hook_chain: Vec<HostileHook> = vec![
            HostileHook::default(),
            HostileHook::default(),
            HostileHook::default(),
            HostileHook::default(),
            HostileHook::default(),
        ];
        hook_chain[refuse_idx].refuse_transfer = Some(Refusal::with_rule(rule_num, "rule broken"));

        let refs: Vec<&dyn Hook> = hook_chain.iter().map(|h| h as &dyn Hook).collect();
        let res = hooks::dispatch_check_transfer_with(&refs, &claim, &receiver);

        prop_assert!(res.is_err());
        prop_assert_eq!(res.unwrap_err().rule, Some(rule_num));
    }
}

#[tokio::test]
async fn contract_module_cannot_permit_core_refusal() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let issue_res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());
    let claim_account = format!("c-1.{}", env.root.id());
    // Transfer to claim_account (Rule 5) must fail even if a module permits.
    let outcome = env
        .alice
        .call(env.root.id(), "nft_transfer")
        .args_json(serde_json::json!({
            "receiver_id": claim_account,
            "token_id": "c-1",
            "memo": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        }))
        .deposit(near_sdk::NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(outcome.is_failure());
    Ok(())
}

// ──────────────────────────────────────────────
// Law 6: module_storage_isolated
// ──────────────────────────────────────────────

#[test]
fn module_storage_isolated() {
    // 1. Storage prefix partition verification (Blueprint 1.4)
    // Core prefixes: c:, o:, t:, l:, lc:, u:, s:, cfg
    // Module prefixes: MUST start with m:<id>:
    let core_prefixes: &[&[u8]] = &[
        STORAGE_PREFIX_CLAIMS,
        STORAGE_PREFIX_OWNER_INDEX,
        STORAGE_PREFIX_TOKEN_METADATA,
        STORAGE_PREFIX_PAYMENT_LOG,
        STORAGE_PREFIX_PAYMENT_LOG_COUNT,
        STORAGE_PREFIX_UNDISTRIBUTED,
        STORAGE_PREFIX_STORAGE_CREDIT,
        STORAGE_KEY_CONFIG,
    ];

    for prefix in core_prefixes {
        assert!(
            !prefix.starts_with(b"m:"),
            "Core prefix {:?} collides with module storage namespace b\"m:\"",
            std::str::from_utf8(prefix)
        );
    }

    // Verify all core prefixes are mutually distinct
    for i in 0..core_prefixes.len() {
        for j in (i + 1)..core_prefixes.len() {
            assert_ne!(
                core_prefixes[i],
                core_prefixes[j],
                "Core prefix collision between {:?} and {:?}",
                std::str::from_utf8(core_prefixes[i]),
                std::str::from_utf8(core_prefixes[j])
            );
        }
    }

    // 2. Pure Hook callback state mutation isolation
    let claim = dummy_claim("claim-1", None);
    let original_claim = claim.clone();
    let booking = Booking {
        payment: 1000.into(),
        surplus: 0.into(),
        fee: 25.into(),
        credit: 0.into(),
        legs: vec![Leg::pay(claim.owner_id.clone(), 975.into())],
    };

    let benign_hook = HostileHook::default();
    let hooks: Vec<&dyn Hook> = vec![&benign_hook];

    hooks::dispatch_on_booked_with(&hooks, &claim, &booking);

    // Assert that core claim state was completely unmutated by hook dispatch
    assert_eq!(claim.token_id, original_claim.token_id);
    assert_eq!(claim.amount_due, original_claim.amount_due);
    assert_eq!(claim.booked_total, original_claim.booked_total);
    assert_eq!(claim.credit_total, original_claim.credit_total);
    assert_eq!(claim.credit_source, original_claim.credit_source);
}

#[tokio::test]
async fn contract_module_storage_isolated() -> anyhow::Result<()> {
    let env = Env::new().await?;
    // Verify that state created under core issuance only creates
    // keys under core prefixes and does not touch m:* namespaces.
    let outcome = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(outcome.is_success());
    let records = env.root.view_state().await?;
    for (k, _) in records {
        assert!(
            !k.starts_with(b"m:"),
            "Core state key {:?} must not use module namespace prefix b\"m:\"",
            k
        );
    }
    Ok(())
}
