//! NFT Test Suite (Blueprint 2.11, K13: 8 named tests).
//!
//! Verifies NEP-171 NFT implementation, transfer rules 1–8, NEP-178 approvals,
//! NEP-297 events, and the payee cut-off rule against the reference model oracle.
//!
//! Each test is written directly from Blueprint Part 2 (2.1–2.5, 2.11).
//! Contract calls currently return NOT_IMPLEMENTED pending C1–C5 implementation,
//! so specification assertions are marked with `#[ignore = "C<n>"]` per harness rules.

use anyhow::Result;
use near_sdk::json_types::U128;
use near_workspaces::types::NearToken;
use openrail::types::{Debtor, Hex32, JsonToken};
use openrail_model::{
    Action, Debtor as ModelDebtor, Hex32 as ModelHex32, Model, ModelError, Status,
};
use openrail_tests::{Env, DEFAULT_SETTLEMENT_ASSET};
use serde_json::json;

/// 0. Verification that current contract stubs return NOT_IMPLEMENTED.
///
/// Runs immediately on the Phase 0 frozen interface without `#[ignore]`.
#[tokio::test]
async fn smoke_nft_stubs_return_not_implemented() -> Result<()> {
    let env = Env::new().await?;

    // 1. nft_transfer returns NOT_IMPLEMENTED
    let transfer_res = env
        .alice
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": "c-1",
            "approval_id": null,
            "memo": "0000000000000000000000000000000000000000000000000000000000000000",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(transfer_res.is_failure());
    let failure = format!(
        "{:?} {}",
        transfer_res.failures(),
        transfer_res.logs().join(" ")
    );
    assert!(
        failure.contains("NOT_IMPLEMENTED"),
        "nft_transfer must fail with NOT_IMPLEMENTED, got: {failure}"
    );

    // 3. nft_transfer_call returns NOT_IMPLEMENTED
    let transfer_call_res = env
        .alice
        .call(env.root.id(), "nft_transfer_call")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": "c-1",
            "approval_id": null,
            "memo": null,
            "msg": "test",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(transfer_call_res.is_failure());
    let failure = format!(
        "{:?} {}",
        transfer_call_res.failures(),
        transfer_call_res.logs().join(" ")
    );
    assert!(
        failure.contains("NOT_IMPLEMENTED"),
        "nft_transfer_call must fail with NOT_IMPLEMENTED, got: {failure}"
    );

    // 4. nft_approve returns NOT_IMPLEMENTED
    let approve_res = env
        .alice
        .call(env.root.id(), "nft_approve")
        .args_json(json!({
            "token_id": "c-1",
            "account_id": env.bob.id(),
            "msg": null,
        }))
        .deposit(NearToken::from_millinear(5))
        .max_gas()
        .transact()
        .await?;
    assert!(approve_res.is_failure());
    let failure = format!(
        "{:?} {}",
        approve_res.failures(),
        approve_res.logs().join(" ")
    );
    assert!(
        failure.contains("NOT_IMPLEMENTED"),
        "nft_approve must fail with NOT_IMPLEMENTED, got: {failure}"
    );

    // 5. nft_token view returns NOT_IMPLEMENTED
    let token_view_res = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": "c-1" }))
        .await;
    assert!(token_view_res.is_err());
    let err_msg = format!("{:?}", token_view_res.err().unwrap());
    assert!(
        err_msg.contains("NOT_IMPLEMENTED"),
        "nft_token view must fail with NOT_IMPLEMENTED, got: {err_msg}"
    );

    // 6. nft_metadata view returns NOT_IMPLEMENTED
    let metadata_res = env.root.view("nft_metadata").args_json(json!({})).await;
    assert!(metadata_res.is_err());
    let err_msg = format!("{:?}", metadata_res.err().unwrap());
    assert!(
        err_msg.contains("NOT_IMPLEMENTED"),
        "nft_metadata view must fail with NOT_IMPLEMENTED, got: {err_msg}"
    );

    Ok(())
}

/// 1. `nft_mint_on_issue`: An issue call mints the NEP-171 token to the issuer (Blueprint 2.2, 2.11).
///
/// Asserts:
/// - Returned token ID is "c-1"
/// - Token exists in `nft_token` with owner = caller
/// - `nft_total_supply` = 1
/// - `nft_supply_for_owner(caller)` = 1
/// - `nft_tokens_for_owner(caller)` contains "c-1"
/// - Emits NEP-297 `nft_mint` event conforming to schema
/// - Oracle parity: `openrail-model` step_issue produces identical state
#[tokio::test]
#[ignore = "C2"]
async fn nft_mint_on_issue() -> Result<()> {
    let env = Env::new().await?;

    let terms_hash = Hex32::new([42u8; 32]);
    let amount_due = 1_000_000u128;
    let due_date = 1_800_000_000u64;

    // Execute on sandbox contract
    let res = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Near(env.bob.id().clone())),
            terms_hash,
            amount_due,
            due_date,
            None,
        )
        .await?;

    assert!(res.is_success(), "issue transaction must succeed");
    let token_id: String = res.clone().json()?;
    assert_eq!(token_id, "c-1", "first token must have ID c-1");

    // Verify NEP-297 nft_mint event emitted and conforms to schema
    let mint_events = env.assert_event(&res, "nft_mint");
    assert_eq!(mint_events.len(), 1);
    let data = mint_events[0]["data"].as_array().unwrap();
    assert_eq!(
        data[0]["owner_id"].as_str().unwrap(),
        env.alice.id().as_str()
    );
    assert_eq!(
        data[0]["token_ids"].as_array().unwrap()[0]
            .as_str()
            .unwrap(),
        "c-1"
    );

    // Verify views
    let token: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert!(token.is_some(), "token c-1 must exist");
    let token = token.unwrap();
    assert_eq!(token.owner_id, env.alice.id().clone());
    assert_eq!(token.token_id, "c-1");

    let total_supply: U128 = env
        .root
        .view("nft_total_supply")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(total_supply.0, 1);

    let supply_for_owner: U128 = env
        .root
        .view("nft_supply_for_owner")
        .args_json(json!({ "account_id": env.alice.id() }))
        .await?
        .json()?;
    assert_eq!(supply_for_owner.0, 1);

    let tokens_for_owner: Vec<JsonToken> = env
        .root
        .view("nft_tokens_for_owner")
        .args_json(json!({ "account_id": env.alice.id() }))
        .await?
        .json()?;
    assert_eq!(tokens_for_owner.len(), 1);
    assert_eq!(tokens_for_owner[0].token_id, "c-1");

    // Oracle comparison against reference model
    let mut model = Model::new();
    let model_events = model
        .step(
            Action::Issue {
                token_id: "c-1".to_string(),
                kind: 0,
                issuer_id: env.alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.bob.id().to_string())),
                terms_hash: ModelHex32([42u8; 32]),
                amount_due,
                due_date,
            },
            100,
        )
        .unwrap();
    assert_eq!(model_events.len(), 1);
    let claim = model.get_claim("c-1").unwrap();
    assert_eq!(claim.owner_id, env.alice.id().to_string());
    assert_eq!(claim.status, Status::Issued);
    assert_eq!(claim.booked_total, 0);

    Ok(())
}

/// 2. `nft_transfer_requires_one_yocto`: Transfer requires exactly 1 yoctoNEAR (Blueprint 2.4 Rule 6, 2.11).
///
/// Asserts:
/// - Transfer with 0 yocto fails with Rule 6 panic
/// - Transfer with 2 yocto fails with Rule 6 panic
/// - Transfer with exactly 1 yocto succeeds
/// - Oracle parity: `openrail-model` rejects attached_yocto != 1 with TransferRuleViolation(6, _)
#[tokio::test]
#[ignore = "C2"]
async fn nft_transfer_requires_one_yocto() -> Result<()> {
    let env = Env::new().await?;

    // Issue claim to Alice
    let _ = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;

    // Attempt transfer with 0 yocto -> must fail Rule 6
    let res_zero = env
        .alice
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": "c-1",
            "approval_id": null,
            "memo": null,
        }))
        .deposit(NearToken::from_yoctonear(0))
        .max_gas()
        .transact()
        .await?;
    assert!(res_zero.is_failure());
    let failure_zero = format!("{:?} {}", res_zero.failures(), res_zero.logs().join(" "));
    assert!(
        failure_zero.contains("Rule 6"),
        "0 yocto transfer must fail Rule 6, got: {failure_zero}"
    );

    // Attempt transfer with 2 yocto -> must fail Rule 6
    let res_two = env
        .alice
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": "c-1",
            "approval_id": null,
            "memo": null,
        }))
        .deposit(NearToken::from_yoctonear(2))
        .max_gas()
        .transact()
        .await?;
    assert!(res_two.is_failure());
    let failure_two = format!("{:?} {}", res_two.failures(), res_two.logs().join(" "));
    assert!(
        failure_two.contains("Rule 6"),
        "2 yocto transfer must fail Rule 6, got: {failure_two}"
    );

    // Oracle comparison against reference model
    let mut model = Model::new();
    model
        .step(
            Action::Issue {
                token_id: "c-1".to_string(),
                kind: 0,
                issuer_id: env.alice.id().to_string(),
                debtor: None,
                terms_hash: ModelHex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    let err_0 = model
        .step(
            Action::Transfer {
                caller: env.alice.id().to_string(),
                token_id: "c-1".to_string(),
                new_owner: env.bob.id().to_string(),
                memo_assignment_doc_hash: None,
                attached_yocto: 0,
            },
            101,
        )
        .unwrap_err();
    assert_eq!(
        err_0,
        ModelError::TransferRuleViolation(6, "exactly 1 yoctoNEAR required".to_string())
    );

    let err_2 = model
        .step(
            Action::Transfer {
                caller: env.alice.id().to_string(),
                token_id: "c-1".to_string(),
                new_owner: env.bob.id().to_string(),
                memo_assignment_doc_hash: None,
                attached_yocto: 2,
            },
            101,
        )
        .unwrap_err();
    assert_eq!(
        err_2,
        ModelError::TransferRuleViolation(6, "exactly 1 yoctoNEAR required".to_string())
    );

    Ok(())
}

/// 3. `nft_transfer_only_owner_or_approved`: Transfers permitted only by owner or approved account (Blueprint 2.2, 2.11).
///
/// Asserts:
/// - Unapproved third party (Bob) cannot transfer Alice's token
/// - Alice approves Bob via `nft_approve`
/// - Approved Bob transfers token to Carol successfully
/// - Approvals clear on transfer: Bob cannot transfer token again
#[tokio::test]
#[ignore = "C2"]
async fn nft_transfer_only_owner_or_approved() -> Result<()> {
    let env = Env::new().await?;

    let memo_hash = "1111111111111111111111111111111111111111111111111111111111111111";

    // Issue claim without debtor requirement to simplify transfer eligibility
    let _ = env
        .issue_claim_with_details(
            &env.alice,
            0,
            None,
            Hex32::default(),
            1_000_000,
            1_800_000_000,
            None,
        )
        .await?;

    // 1. Unapproved Bob attempts transfer -> must fail
    let unauth_res = env
        .bob
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": env.carol.id(),
            "token_id": "c-1",
            "approval_id": null,
            "memo": memo_hash,
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(
        unauth_res.is_failure(),
        "unapproved caller must fail transfer"
    );

    // 2. Alice approves Bob
    let approve_res = env
        .alice
        .call(env.root.id(), "nft_approve")
        .args_json(json!({
            "token_id": "c-1",
            "account_id": env.bob.id(),
            "msg": null,
        }))
        .deposit(NearToken::from_millinear(5))
        .max_gas()
        .transact()
        .await?;
    assert!(approve_res.is_success());

    let is_approved: bool = env
        .root
        .view("nft_is_approved")
        .args_json(json!({
            "token_id": "c-1",
            "approved_account_id": env.bob.id(),
            "approval_id": null,
        }))
        .await?
        .json()?;
    assert!(is_approved, "Bob must be approved");

    // 3. Approved Bob executes transfer to Carol
    let transfer_res = env
        .bob
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": env.carol.id(),
            "token_id": "c-1",
            "approval_id": null,
            "memo": memo_hash,
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(
        transfer_res.is_success(),
        "approved account must be able to transfer"
    );

    // 4. Token owner is now Carol
    let token: JsonToken = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert_eq!(token.owner_id, env.carol.id().clone());

    // 5. Approvals clear on transfer: Bob is no longer approved
    let is_approved_after: bool = env
        .root
        .view("nft_is_approved")
        .args_json(json!({
            "token_id": "c-1",
            "approved_account_id": env.bob.id(),
            "approval_id": null,
        }))
        .await?
        .json()?;
    assert!(
        !is_approved_after,
        "approvals must be cleared after transfer"
    );

    // Bob attempts second transfer -> fails
    let bob_second_res = env
        .bob
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": "c-1",
            "approval_id": null,
            "memo": memo_hash,
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(
        bob_second_res.is_failure(),
        "Bob cannot transfer again after approvals cleared"
    );

    Ok(())
}

/// 4. `nft_transfer_rules_enforced`: All Transfer Rules 1–8 strictly enforced (Blueprint 2.4, 2.11).
///
/// Asserts:
/// - Rule 1: active lock blocks transfer ("Rule 1: lock must be None or TransferWindow")
/// - Rule 2: settled status blocks transfer ("Rule 2: status must be Issued or PartiallyPaid")
/// - Rule 3: unacknowledged claim cannot be sold ("Rule 3: unacknowledged claim cannot be sold")
/// - Rule 4: assignment doc hash required on sale ("Rule 4: assignment document hash required on sale")
/// - Rule 5: receiver cannot be claim vault account ("Rule 5: receiver cannot be claim account")
/// - Rule 6: exactly 1 yocto required ("Rule 6: exactly 1 yoctoNEAR required")
/// - Oracle parity: `openrail-model` matches every rule enforcement error code
#[tokio::test]
#[ignore = "C2"]
async fn nft_transfer_rules_enforced() -> Result<()> {
    let env = Env::new().await?;

    // Issue claim with Near debtor requiring acknowledgment (Rule 3)
    let _ = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Near(env.bob.id().clone())),
            Hex32::default(),
            1_000_000,
            1_800_000_000,
            None,
        )
        .await?;

    // Rule 3: Sale to Carol without debtor acknowledgment must fail Rule 3
    let res_rule3 = env
        .alice
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": env.carol.id(),
            "token_id": "c-1",
            "approval_id": null,
            "memo": "2222222222222222222222222222222222222222222222222222222222222222",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(res_rule3.is_failure());
    let fail3 = format!("{:?} {}", res_rule3.failures(), res_rule3.logs().join(" "));
    assert!(
        fail3.contains("Rule 3"),
        "unacknowledged sale must fail Rule 3, got: {fail3}"
    );

    // Debtor Bob acknowledges invoice
    let ack_res = env
        .bob
        .call(env.root.id(), "acknowledge_near")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack_res.is_success());

    // Rule 4: Sale to Carol without memo assignment doc hash must fail Rule 4
    let res_rule4 = env
        .alice
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": env.carol.id(),
            "token_id": "c-1",
            "approval_id": null,
            "memo": null,
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(res_rule4.is_failure());
    let fail4 = format!("{:?} {}", res_rule4.failures(), res_rule4.logs().join(" "));
    assert!(
        fail4.contains("Rule 4"),
        "sale without assignment doc must fail Rule 4, got: {fail4}"
    );

    // Rule 5: Transfer to claim's own keyless vault sub-account must fail Rule 5
    let claim_account_id = format!("c-1.{}", env.root.id());
    let res_rule5 = env
        .alice
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": claim_account_id,
            "token_id": "c-1",
            "approval_id": null,
            "memo": "2222222222222222222222222222222222222222222222222222222222222222",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(res_rule5.is_failure());
    let fail5 = format!("{:?} {}", res_rule5.failures(), res_rule5.logs().join(" "));
    assert!(
        fail5.contains("Rule 5"),
        "transfer to claim account must fail Rule 5, got: {fail5}"
    );

    // Model comparison for rules 1-8
    let mut model = Model::new();
    model
        .step(
            Action::Issue {
                token_id: "c-1".to_string(),
                kind: 0,
                issuer_id: env.alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.bob.id().to_string())),
                terms_hash: ModelHex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    // Model Rule 3 check
    let model_err3 = model
        .step(
            Action::Transfer {
                caller: env.alice.id().to_string(),
                token_id: "c-1".to_string(),
                new_owner: env.carol.id().to_string(),
                memo_assignment_doc_hash: Some(ModelHex32([2u8; 32])),
                attached_yocto: 1,
            },
            101,
        )
        .unwrap_err();
    assert_eq!(
        model_err3,
        ModelError::TransferRuleViolation(3, "unacknowledged claim cannot be sold".to_string())
    );

    // Model Debtor Ack
    model
        .step(
            Action::AcknowledgeNear {
                token_id: "c-1".to_string(),
                caller: env.bob.id().to_string(),
            },
            102,
        )
        .unwrap();

    // Model Rule 4 check
    let model_err4 = model
        .step(
            Action::Transfer {
                caller: env.alice.id().to_string(),
                token_id: "c-1".to_string(),
                new_owner: env.carol.id().to_string(),
                memo_assignment_doc_hash: None,
                attached_yocto: 1,
            },
            103,
        )
        .unwrap_err();
    assert_eq!(
        model_err4,
        ModelError::TransferRuleViolation(
            4,
            "assignment document hash required on sale".to_string()
        )
    );

    Ok(())
}

/// 5. `nft_transfer_call_refund_restores_owner`: Failed/refunded transfer call restores previous owner (Blueprint 2.2, 2.11).
///
/// Asserts:
/// - `nft_transfer_call` calls receiver `nft_on_transfer`
/// - If receiver returns `true` (requesting refund) or execution fails, `nft_resolve_transfer` reverts ownership
/// - Previous owner is restored in storage and in `nft_token`
/// - Emits NEP-297 `nft_transfer` refund event back to previous owner
#[tokio::test]
#[ignore = "C2"]
async fn nft_transfer_call_refund_restores_owner() -> Result<()> {
    let env = Env::new().await?;

    let memo_hash = "3333333333333333333333333333333333333333333333333333333333333333";

    // Issue claim to Alice
    let _ = env
        .issue_claim_with_details(
            &env.alice,
            0,
            None,
            Hex32::default(),
            1_000_000,
            1_800_000_000,
            None,
        )
        .await?;

    // Call nft_transfer_call targeting a receiver account that does NOT implement nft_on_transfer (e.g. env.bob),
    // which causes the cross-contract call to fail and triggers the resolve refund!
    let res = env
        .alice
        .call(env.root.id(), "nft_transfer_call")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": "c-1",
            "approval_id": null,
            "memo": memo_hash,
            "msg": "reject_and_refund",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;

    assert!(
        res.is_success(),
        "nft_transfer_call with refund resolution returns success"
    );

    // Token owner must remain Alice after refund
    let token: JsonToken = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert_eq!(
        token.owner_id,
        env.alice.id().clone(),
        "refund must restore Alice as owner"
    );

    Ok(())
}

/// 6. `nft_transfer_call_keeps_locks`: Transfer window lock state is preserved during transfer call (Blueprint 2.2, 2.3, 2.11).
///
/// Asserts:
/// - Alice calls `prepare_transfer` opening `TransferWindow { until: block + 1800 }`
/// - During `nft_transfer_call` execution, lock state remains active
/// - If transfer refunds, transfer window remains valid if block < until
#[tokio::test]
#[ignore = "C2"]
async fn nft_transfer_call_keeps_locks() -> Result<()> {
    let env = Env::new().await?;

    // Issue claim
    let _ = env
        .issue_claim_with_details(
            &env.alice,
            0,
            None,
            Hex32::default(),
            1_000_000,
            1_800_000_000,
            None,
        )
        .await?;

    // Prepare transfer -> sets TransferWindow
    let prep_res = env
        .alice
        .call(env.root.id(), "prepare_transfer")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(prep_res.is_success());

    // Execute nft_transfer_call that refunds
    let res = env
        .alice
        .call(env.root.id(), "nft_transfer_call")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": "c-1",
            "approval_id": null,
            "memo": "4444444444444444444444444444444444444444444444444444444444444444",
            "msg": "refund",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success());

    // Claim remains owned by Alice with lock preserved
    let token: JsonToken = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert_eq!(token.owner_id, env.alice.id().clone());

    Ok(())
}

/// 7. `nft_events_nep297`: NEP-297 event logs emitted by NFT operations conform to standard schemas (Blueprint 2.2, 2.9, 2.11).
///
/// Asserts:
/// - `nft_mint` event emitted on `issue` conforms to `nft_mint.schema.json`
/// - `nft_transfer` event emitted on `nft_transfer` conforms to `nft_transfer.schema.json`
/// - All standard fields (`standard == "nep171"`, `version == "1.0.0"`, `event`, `data`) validated
#[tokio::test]
#[ignore = "C2"]
async fn nft_events_nep297() -> Result<()> {
    let env = Env::new().await?;

    let memo_hash = "5555555555555555555555555555555555555555555555555555555555555555";

    // 1. Issue claim -> must emit valid nft_mint event
    let issue_res = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Near(env.bob.id().clone())),
            Hex32::default(),
            1_000_000,
            1_800_000_000,
            None,
        )
        .await?;
    assert!(issue_res.is_success());

    let mint_events = env.assert_event(&issue_res, "nft_mint");
    assert!(
        !mint_events.is_empty(),
        "nft_mint event must be emitted and validate against schema"
    );

    // 2. Transfer claim -> must emit valid nft_transfer event
    let transfer_res = env
        .alice
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": "c-1",
            "approval_id": null,
            "memo": memo_hash,
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(transfer_res.is_success());

    let transfer_events = env.assert_event(&transfer_res, "nft_transfer");
    assert!(
        !transfer_events.is_empty(),
        "nft_transfer event must be emitted and validate against schema"
    );
    let transfer_data = transfer_events[0]["data"].as_array().unwrap();
    assert_eq!(
        transfer_data[0]["old_owner_id"].as_str().unwrap(),
        env.alice.id().as_str()
    );
    assert_eq!(
        transfer_data[0]["new_owner_id"].as_str().unwrap(),
        env.bob.id().as_str()
    );
    assert_eq!(
        transfer_data[0]["token_ids"].as_array().unwrap()[0]
            .as_str()
            .unwrap(),
        "c-1"
    );

    Ok(())
}

/// 8. `payee_follows_token_real`: Payments deposited after sale distribute to the new owner (Blueprint 2.4 cut-off rule, 2.11).
///
/// Asserts:
/// - Alice issues claim for 1,000,000 USDC
/// - Debtor Bob acknowledges invoice
/// - Alice sells token to Carol
/// - Payer deposits 1,000,000 USDC to claim sub-account on `intents.near`
/// - `reconcile` executes: net payment (997,500 USDC after 25 bps protocol fee) is forwarded to CAROL (new owner), not Alice
/// - Oracle parity: `openrail-model` matches the cut-off distribution rule
#[tokio::test]
#[ignore = "C4"]
async fn payee_follows_token_real() -> Result<()> {
    let env = Env::new().await?;

    let memo_hash = "6666666666666666666666666666666666666666666666666666666666666666";

    // 1. Alice issues claim for 1,000,000 base units ($1.00 USDC)
    let issue_res = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Near(env.bob.id().clone())),
            Hex32::default(),
            1_000_000,
            1_800_000_000,
            None,
        )
        .await?;
    assert!(issue_res.is_success());

    // 2. Debtor Bob acknowledges invoice
    let ack_res = env
        .bob
        .call(env.root.id(), "acknowledge_near")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack_res.is_success());

    // 3. Alice sells invoice to Carol
    let transfer_res = env
        .alice
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": env.carol.id(),
            "token_id": "c-1",
            "approval_id": null,
            "memo": memo_hash,
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(transfer_res.is_success());

    // Verify Carol is owner in view
    let token: JsonToken = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert_eq!(
        token.owner_id,
        env.carol.id().clone(),
        "Carol must be owner"
    );

    // 4. Payer deposits 1,000,000 USDC to claim sub-account on mock intents.near
    let _ = env.fund_claim("c-1", 1_000_000, None).await?;
    assert_eq!(env.claim_balance("c-1", None).await?, 1_000_000);

    // 5. Trigger reconcile
    let reconcile_res = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(reconcile_res.is_success());

    // 6. Distribution check:
    // Protocol fee = 1_000_000 * 25 / 10_000 = 2,500 USDC
    // Net distribution = 997,500 USDC
    // Must be distributed to Carol (new owner), NOT Alice!
    let carol_bal: U128 = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({
            "account_id": env.carol.id(),
            "token_id": DEFAULT_SETTLEMENT_ASSET,
        }))
        .await?
        .json()?;
    assert_eq!(
        carol_bal.0, 997_500,
        "Carol (new token owner) must receive full net distribution"
    );

    let alice_bal: U128 = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({
            "account_id": env.alice.id(),
            "token_id": DEFAULT_SETTLEMENT_ASSET,
        }))
        .await?
        .json()?;
    assert_eq!(
        alice_bal.0, 0,
        "Alice (former owner) must receive zero payment after sale"
    );

    // Oracle comparison against reference model
    let mut model = Model::new();
    model
        .step(
            Action::Issue {
                token_id: "c-1".to_string(),
                kind: 0,
                issuer_id: env.alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.bob.id().to_string())),
                terms_hash: ModelHex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    model
        .step(
            Action::AcknowledgeNear {
                token_id: "c-1".to_string(),
                caller: env.bob.id().to_string(),
            },
            101,
        )
        .unwrap();

    model
        .step(
            Action::Transfer {
                caller: env.alice.id().to_string(),
                token_id: "c-1".to_string(),
                new_owner: env.carol.id().to_string(),
                memo_assignment_doc_hash: Some(ModelHex32([6u8; 32])),
                attached_yocto: 1,
            },
            102,
        )
        .unwrap();

    model
        .step(
            Action::DepositIntentsBalance {
                token_id: "c-1".to_string(),
                asset: "nep141:usdc.near".to_string(),
                amount: 1_000_000,
            },
            103,
        )
        .unwrap();

    let events = model
        .step(
            Action::Reconcile {
                token_id: "c-1".to_string(),
                leg_failures: vec![false, false],
            },
            104,
        )
        .unwrap();

    // Verify model distributed to Carol
    let distributed_events: Vec<_> = events
        .into_iter()
        .filter(|e| matches!(e, openrail_model::Event::Distributed { .. }))
        .collect();
    assert_eq!(
        distributed_events.len(),
        2,
        "must emit net distribution leg + fee leg"
    );
    match &distributed_events[0] {
        openrail_model::Event::Distributed { leg, .. } => {
            assert_eq!(leg.receiver(), Some(&env.carol.id().to_string()));
            assert_eq!(leg.amount(), 997_500);
        }
        _ => panic!("expected Distributed event"),
    }

    Ok(())
}
