//! Compile-time type inference verification for registered hooks (Prompt Update 4 / ph1-ci-lint).
//!
//! Verifies that `vec![#[cfg] &a::HOOK, #[cfg] &b::HOOK]` where `a` and `b` are two
//! distinct concrete types correctly infers as `Vec<&'static dyn openrail::hooks::Hook>`.

use near_sdk::AccountId;
use openrail::hooks::{self, Hook, KindRules, Refusal};
use openrail::types::{Claim, Hex32, Lock, Status};
use std::collections::HashMap;

mod fake_module_a {
    use super::*;

    pub struct HookA {
        pub custom_param: &'static str,
    }

    impl Hook for HookA {
        fn check_transfer(&self, _claim: &Claim, _receiver: &AccountId) -> Result<(), Refusal> {
            Ok(())
        }

        fn kind_rules(&self, _kind: u8) -> KindRules {
            KindRules {
                ack_required_for_sale: true,
                sellable: true,
                quote_deadline: 1800,
                debtor_optional: false,
            }
        }
    }

    pub static HOOK: HookA = HookA {
        custom_param: "alpha",
    };
}

mod fake_module_b {
    use super::*;

    pub struct HookB {
        pub min_duration: u64,
    }

    impl Hook for HookB {
        fn in_motion(&self, _claim: &Claim) -> bool {
            false
        }

        fn kind_rules(&self, _kind: u8) -> KindRules {
            KindRules {
                ack_required_for_sale: false,
                sellable: true,
                quote_deadline: 7200,
                debtor_optional: true,
            }
        }
    }

    pub static HOOK: HookB = HookB { min_duration: 3600 };
}

/// Simulated function mirroring the exact structure emitted by scripts/gen-modules.ts
/// with multiple enabled modules whose folders exist.
pub fn registered() -> Vec<&'static dyn Hook> {
    vec![&fake_module_a::HOOK, &fake_module_b::HOOK]
}

#[test]
fn test_registered_two_concrete_hook_types_compile_and_dispatch() {
    let hook_list = registered();
    assert_eq!(hook_list.len(), 2);
    assert_eq!(fake_module_a::HOOK.custom_param, "alpha");
    assert_eq!(fake_module_b::HOOK.min_duration, 3600);

    let dummy_account: AccountId = "alice.near".parse().unwrap();
    let dummy_claim = Claim {
        token_id: "claim-1".to_string(),
        kind: 1,
        issuer_id: dummy_account.clone(),
        owner_id: dummy_account.clone(),
        claim_account: "c1.near".parse().unwrap(),
        debtor: None,
        terms_hash: Hex32([0u8; 32]),
        amount_due: 1_000_000.into(),
        due_date: 200,
        ack: None,
        status: Status::Issued,
        lock: Lock::None,
        settlement_assets: vec!["nep141:usdc.near".to_string()],
        booked_total: 0.into(),
        distributed_total: 0.into(),
        fee_total: 0.into(),
        surplus: 0.into(),
        credit_total: 0.into(),
        credit_source: None,
        last_seen_balance: HashMap::new(),
        assignment_doc_hash: None,
        created_block: 10,
    };

    assert!(hooks::dispatch_check_transfer_with(&hook_list, &dummy_claim, &dummy_account).is_ok());
    assert!(hooks::dispatch_check_cancel_with(&hook_list, &dummy_claim).is_ok());
    assert!(!hooks::dispatch_in_motion_with(&hook_list, &dummy_claim));
    let rules = hooks::dispatch_kind_rules_with(&hook_list, 1);
    assert_eq!(rules.quote_deadline, 1800);
    assert_eq!(hook_list[1].kind_rules(1).quote_deadline, 7200);
}
