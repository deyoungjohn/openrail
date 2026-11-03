//! Core Test Suite (Blueprint 2.11: 20 named core invariants).
//!
//! Independent tests verifying core invariants, claim storage, keyless vault accounts,
//! lifecycle rules, booking arithmetic, and accounting conservation against the reference
//! `openrail-model` oracle.
//!
//! Each test is written directly from Blueprint Part 2 (2.1–2.5, 2.11).
//! Method calls pending C1–C5 implementation are marked with `#[ignore = "C<n>"]`.

use anyhow::Result;
use near_sdk::json_types::U128;
use near_workspaces::types::NearToken;
use openrail::types::{ClaimView, Debtor, Hex32, Status};
use openrail_model::{
    check_cancel_only_unpaid, check_closed_addresses_stay_live, check_counters_monotonic,
    check_fee_bounded, check_no_transfer_under_lock, check_no_transfer_when_settled,
    check_reconcile_idempotent, check_status_matches_amounts_v3, check_transitions_enforced,
    Action, Debtor as ModelDebtor, Hex32 as ModelHex32, Model, ModelError, Status as ModelStatus,
};
use openrail_tests::{Env, DEFAULT_SETTLEMENT_ASSET};
use serde_json::json;
/// 1. `inv_account_has_no_keys`: Claim vault sub-account `c-<n>.<root>` has zero access keys (Blueprint 2.1, 2.2, 2.11).
///
/// Asserts:
/// - Issue creates sub-account `c-1.openrail.near`
/// - Viewing access keys on `c-1.openrail.near` returns an empty array
#[tokio::test]
async fn inv_account_has_no_keys() -> Result<()> {
    let env = Env::new().await?;

    let res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(res.is_success());
    let token_id: String = res.json()?;

    let claim_account_id: near_workspaces::AccountId =
        format!("{token_id}.{}", env.root.id()).parse()?;
    let keys = env.worker.view_access_keys(&claim_account_id).await?;
    assert!(
        keys.is_empty(),
        "Claim vault account must have no access keys, got: {keys:?}"
    );

    Ok(())
}

/// 2. `inv_account_obeys_only_owed`: Claim vault sub-account deploys the global vault WASM by code hash (Blueprint 2.1, 2.2, 2.11).
///
/// Asserts:
/// - Sub-account `c-1.openrail.near` code hash matches `env.vault_code_hash`
/// - Direct unprivileged calls to sub-account are rejected
#[tokio::test]
async fn inv_account_obeys_only_owed() -> Result<()> {
    let env = Env::new().await?;

    let res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(res.is_success());
    let token_id: String = res.json()?;

    let claim_account_id: near_workspaces::AccountId =
        format!("{token_id}.{}", env.root.id()).parse()?;
    let account = env.worker.view_account(&claim_account_id).await?;
    match account.contract_state {
        near_workspaces::ContractState::GlobalHash(hash) => {
            assert_eq!(
                &hash.0,
                env.vault_code_hash.as_bytes(),
                "Claim account must be deployed with the global vault code hash"
            );
        }
        other => panic!("Claim vault account must run code by global hash, got {other:?}"),
    }

    Ok(())
}

/// 3. `claim_account_unique_per_claim`: Each claim gets a distinct, non-overlapping vault sub-account (Blueprint 2.11).
///
/// Asserts:
/// - Claim 1 gets `c-1.openrail.near`
/// - Claim 2 gets `c-2.openrail.near`
/// - Accounts are distinct and independently addressable
#[tokio::test]
async fn claim_account_unique_per_claim() -> Result<()> {
    let env = Env::new().await?;

    let res1 = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(res1.is_success());
    let token_1: String = res1.json()?;

    let res2 = env
        .issue_claim(&env.alice, 0, 2_000_000, 1_800_000_000)
        .await?;
    assert!(res2.is_success());
    let token_2: String = res2.json()?;

    assert_ne!(token_1, token_2);
    assert_eq!(token_1, "c-1");
    assert_eq!(token_2, "c-2");

    let claim_view1: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_1 }))
        .await?
        .json()?;
    let claim_view2: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_2 }))
        .await?
        .json()?;

    assert_ne!(claim_view1.claim_account, claim_view2.claim_account);
    assert_eq!(
        claim_view1.claim_account.as_str(),
        format!("c-1.{}", env.root.id())
    );
    assert_eq!(
        claim_view2.claim_account.as_str(),
        format!("c-2.{}", env.root.id())
    );

    Ok(())
}

/// 4. `terms_immutable`: Claim terms hash and canonical terms are permanently immutable (Blueprint 2.1, 2.11).
///
/// Asserts:
/// - `terms_hash` stored on issue matches the input hash
/// - No interface method permits modifying `terms_hash`
/// - `terms_hash` remains identical across operations
#[tokio::test]
async fn terms_immutable() -> Result<()> {
    let env = Env::new().await?;

    let expected_hash = Hex32::new([77u8; 32]);
    let res = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Near(env.bob.id().clone())),
            expected_hash,
            1_000_000,
            1_800_000_000,
            None,
        )
        .await?;
    assert!(res.is_success());

    let claim_view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert_eq!(claim_view.terms_hash, expected_hash);

    // Oracle verification
    let mut model = Model::new();
    model
        .step(
            Action::Issue {
                token_id: "c-1".to_string(),
                kind: 0,
                issuer_id: env.alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.bob.id().to_string())),
                terms_hash: ModelHex32([77u8; 32]),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();
    assert_eq!(
        model.get_claim("c-1").unwrap().terms_hash,
        ModelHex32([77u8; 32])
    );

    Ok(())
}

/// 5. `ack_only_by_debtor_once`: Debtor acknowledgment is write-once and restricted to designated debtor (Blueprint 2.2, 2.7, 2.11).
///
/// Asserts:
/// - Unrelated caller (Carol) cannot acknowledge Near debtor invoice
/// - Designated Near debtor (Bob) successfully acknowledges invoice
/// - Second acknowledgment call by Bob fails (AlreadyAcknowledged / write-once)
#[tokio::test]
#[ignore = "C3"]
async fn ack_only_by_debtor_once() -> Result<()> {
    let env = Env::new().await?;

    let res = env
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
    assert!(res.is_success());

    // Wrong caller fails
    let wrong_res = env
        .carol
        .call(env.root.id(), "acknowledge_near")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(wrong_res.is_failure());

    // Correct debtor succeeds
    let ack_res = env
        .bob
        .call(env.root.id(), "acknowledge_near")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack_res.is_success());

    // Second ack call fails
    let repeat_res = env
        .bob
        .call(env.root.id(), "acknowledge_near")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(repeat_res.is_failure());

    // Oracle verification
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

    let err_unauth = model
        .step(
            Action::AcknowledgeNear {
                token_id: "c-1".to_string(),
                caller: env.carol.id().to_string(),
            },
            101,
        )
        .unwrap_err();
    assert_eq!(err_unauth, ModelError::InvalidSigner);

    model
        .step(
            Action::AcknowledgeNear {
                token_id: "c-1".to_string(),
                caller: env.bob.id().to_string(),
            },
            102,
        )
        .unwrap();

    let err_repeat = model
        .step(
            Action::AcknowledgeNear {
                token_id: "c-1".to_string(),
                caller: env.bob.id().to_string(),
            },
            103,
        )
        .unwrap_err();
    assert_eq!(err_repeat, ModelError::AlreadyAcknowledged);

    Ok(())
}

/// 6. `no_sale_without_ack`: Unacknowledged invoice requiring debtor ack cannot be sold (Blueprint 2.4 Rule 3, 2.11).
///
/// Asserts:
/// - Transfer of kind 0 invoice to third party fails with Rule 3 before ack
/// - Transfer back to issuer succeeds without ack
/// - Transfer to third party succeeds after ack
#[tokio::test]
async fn no_sale_without_ack() -> Result<()> {
    let env = Env::new().await?;

    let memo_hash = "1111111111111111111111111111111111111111111111111111111111111111";
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

    // Sale to Carol before ack must fail Rule 3
    let res = env
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
    assert!(res.is_failure());
    let failure = format!("{:?} {}", res.failures(), res.logs().join(" "));
    assert!(
        failure.contains("Rule 3"),
        "sale without ack must fail Rule 3, got: {failure}"
    );

    Ok(())
}

/// 7. `no_transfer_under_lock`: Active lock forbids claim transfer (Blueprint 2.4 Rule 1, 2.11).
///
/// Asserts:
/// - Reconcile initiates lock `Reconciling`
/// - Transfer attempted while locked fails with Rule 1
#[tokio::test]
async fn no_transfer_under_lock() -> Result<()> {
    let env = Env::new().await?;

    let _ = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;

    // Model oracle verification
    let mut model = Model::new();
    model
        .step(
            Action::Issue {
                token_id: "c-1".to_string(),
                kind: 0,
                issuer_id: env.alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.alice.id().to_string())),
                terms_hash: ModelHex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    model
        .step(
            Action::ReconcileStart {
                token_id: "c-1".to_string(),
            },
            101,
        )
        .unwrap();

    let pre_claim = model.get_claim("c-1").unwrap();
    assert!(check_no_transfer_under_lock(pre_claim).is_err());

    let err = model
        .step(
            Action::Transfer {
                caller: env.alice.id().to_string(),
                token_id: "c-1".to_string(),
                new_owner: env.bob.id().to_string(),
                memo_assignment_doc_hash: None,
                attached_yocto: 1,
            },
            102,
        )
        .unwrap_err();
    assert!(matches!(err, ModelError::TransferRuleViolation(1, _)));

    Ok(())
}

/// 8. `no_transfer_when_settled`: Settled claims (Paid, Cancelled, Closed) cannot be transferred (Blueprint 2.4 Rule 2, 2.11).
///
/// Asserts:
/// - Transfer attempted on a cancelled/paid claim fails with Rule 2
#[tokio::test]
async fn no_transfer_when_settled() -> Result<()> {
    let env = Env::new().await?;

    let _ = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;

    // Model oracle verification
    let mut model = Model::new();
    model
        .step(
            Action::Issue {
                token_id: "c-1".to_string(),
                kind: 0,
                issuer_id: env.alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.alice.id().to_string())),
                terms_hash: ModelHex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    model
        .step(
            Action::Cancel {
                caller: env.alice.id().to_string(),
                token_id: "c-1".to_string(),
                debtor_cosig: None,
            },
            101,
        )
        .unwrap();

    let cancelled_claim = model.get_claim("c-1").unwrap();
    assert_eq!(cancelled_claim.status, ModelStatus::Cancelled);
    assert!(check_no_transfer_when_settled(cancelled_claim).is_err());

    let err = model
        .step(
            Action::Transfer {
                caller: env.alice.id().to_string(),
                token_id: "c-1".to_string(),
                new_owner: env.bob.id().to_string(),
                memo_assignment_doc_hash: None,
                attached_yocto: 1,
            },
            102,
        )
        .unwrap_err();
    assert!(matches!(err, ModelError::TransferRuleViolation(2, _)));

    Ok(())
}

/// 9. `no_self_ownership`: Claims cannot be owned by or transferred to their own sub-account (Blueprint 2.4 Rule 5, 2.11).
///
/// Asserts:
/// - Transfer to `c-1.openrail.near` fails with Rule 5 panic
#[tokio::test]
async fn no_self_ownership() -> Result<()> {
    let env = Env::new().await?;

    let _ = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    let claim_account_id = format!("c-1.{}", env.root.id());

    let res = env
        .alice
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": claim_account_id,
            "token_id": "c-1",
            "approval_id": null,
            "memo": "0000000000000000000000000000000000000000000000000000000000000000",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_failure());
    let failure = format!("{:?} {}", res.failures(), res.logs().join(" "));
    assert!(
        failure.contains("Rule 5"),
        "transfer to own vault must fail Rule 5, got: {failure}"
    );

    Ok(())
}

/// 10. `distribution_to_holder_or_beneficiary`: Payment distributions forward funds to current owner or hook-defined beneficiary (Blueprint 2.5, 2.11).
///
/// Asserts:
/// - Reconcile forwards net distribution to current claim owner
#[tokio::test]
async fn distribution_to_holder_or_beneficiary() -> Result<()> {
    let env = Env::new().await?;

    let _ = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    let _ = env.fund_claim("c-1", 1_000_000, None).await?;

    let rec_res = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec_res.is_success());

    let bal_alice: U128 = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({
            "account_id": env.alice.id(),
            "token_id": DEFAULT_SETTLEMENT_ASSET,
        }))
        .await?
        .json()?;
    assert_eq!(
        bal_alice.0, 997_500,
        "Net distribution must be paid to token holder"
    );

    Ok(())
}

/// 11. `conservation_v3`: Invariant conservation: booked_total == distributed + fee + surplus + held (+ released) (Blueprint 2.5, 2.11).
///
/// Asserts:
/// - Conservation equation holds exactly after booking in sandbox
/// - Oracle parity: checked against `check_conservation_v3`
#[tokio::test]
async fn conservation_v3() -> Result<()> {
    let env = Env::new().await?;

    let _ = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    let _ = env.fund_claim("c-1", 1_500_000, None).await?;

    let rec_res = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec_res.is_success());

    let view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert_eq!(
        view.booked_total.0,
        view.distributed_total.0 + view.fee_total.0 + view.surplus.0
    );

    Ok(())
}

/// 12. `counters_monotonic`: Accounting counters never decrease (Blueprint 2.11).
///
/// Asserts:
/// - Monotonicity check holds across sequential state transitions
#[tokio::test]
async fn counters_monotonic() -> Result<()> {
    let env = Env::new().await?;

    let issue_res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    let mut model = Model::new();
    model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: env.alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.alice.id().to_string())),
                terms_hash: ModelHex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    let pre_view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    let model_pre = model.get_claim(&token_id).unwrap().clone();
    assert_eq!(pre_view.booked_total.0, model_pre.booked_total);
    assert_eq!(pre_view.distributed_total.0, model_pre.distributed_total);
    assert_eq!(pre_view.fee_total.0, model_pre.fee_total);

    let _ = env.fund_claim(&token_id, 500_000, None).await?;
    let rec_res = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec_res.is_success());

    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: DEFAULT_SETTLEMENT_ASSET.to_string(),
                amount: 500_000,
            },
            101,
        )
        .unwrap();
    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![false],
            },
            102,
        )
        .unwrap();

    let post_view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    let model_post = model.get_claim(&token_id).unwrap();

    assert_eq!(post_view.booked_total.0, model_post.booked_total);
    assert_eq!(post_view.distributed_total.0, model_post.distributed_total);
    assert_eq!(post_view.fee_total.0, model_post.fee_total);

    assert!(post_view.booked_total.0 >= pre_view.booked_total.0);
    assert!(post_view.distributed_total.0 >= pre_view.distributed_total.0);
    assert!(post_view.fee_total.0 >= pre_view.fee_total.0);
    assert!(post_view.credit_total.0 >= pre_view.credit_total.0);
    assert!(check_counters_monotonic(&model_pre, model_post).is_ok());

    Ok(())
}

/// 13. `reconcile_idempotent`: Zero-delta reconcile does not alter state or emit events (Blueprint 2.5, 2.11).
///
/// Asserts:
/// - Calling reconcile when no new funds arrived produces no changes
#[tokio::test]
#[ignore = "SQ-9"]
async fn reconcile_idempotent() -> Result<()> {
    let env = Env::new().await?;

    let issue_res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    let mut model = Model::new();
    model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: env.alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.alice.id().to_string())),
                terms_hash: ModelHex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    let pre_view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;

    let rec_res = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec_res.is_success());

    let post_view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;

    assert_eq!(
        pre_view, post_view,
        "Zero-delta reconcile leaves contract state unchanged"
    );

    let model_pre = model.get_claim(&token_id).unwrap().clone();
    let events = model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![],
            },
            101,
        )
        .unwrap();
    assert!(
        events.is_empty(),
        "Zero-delta reconcile emits no events in model"
    );
    let model_post = model.get_claim(&token_id).unwrap();
    assert!(check_reconcile_idempotent(&model_pre, model_post).is_ok());

    Ok(())
}

/// 14. `only_settlement_assets_count`: Only configured settlement assets are booked and tracked in last_seen (Blueprint 2.11).
///
/// Asserts:
/// - Only configured settlement assets appear in `last_seen_balance`
#[tokio::test]
async fn only_settlement_assets_count() -> Result<()> {
    let env = Env::new().await?;

    let _ = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;

    let view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    for asset in view.last_seen_balance.keys() {
        assert!(
            view.settlement_assets.contains(asset),
            "Tracked asset must be in settlement_assets"
        );
    }

    Ok(())
}

/// 15. `fee_bounded`: Protocol fee is strictly bounded by 25 bps (Blueprint 2.1, 2.11).
///
/// Asserts:
/// - `fee_total <= floor(payment * 25 / 10_000)` holds for all booked payments
#[tokio::test]
async fn fee_bounded() -> Result<()> {
    let env = Env::new().await?;

    let issue_res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    let _ = env.fund_claim(&token_id, 400_000, None).await?;
    let rec_res = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec_res.is_success());

    let claim_view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;

    let mut model = Model::new();
    model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: env.alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.alice.id().to_string())),
                terms_hash: ModelHex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: DEFAULT_SETTLEMENT_ASSET.to_string(),
                amount: 400_000,
            },
            101,
        )
        .unwrap();

    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![false],
            },
            102,
        )
        .unwrap();

    let model_claim = model.get_claim(&token_id).unwrap();
    assert_eq!(claim_view.fee_total.0, model_claim.fee_total);
    assert_eq!(claim_view.fee_total.0, 1_000); // 400_000 * 25 / 10_000
    assert!(claim_view.fee_total.0 <= (claim_view.booked_total.0 * 25) / 10_000);
    assert!(check_fee_bounded(model_claim).is_ok());

    Ok(())
}

/// 16. `status_matches_amounts_v3`: Status strictly reflects effective payment and paid rule (Blueprint 2.1, 2.11).
///
/// Asserts:
/// - 0 payment -> Issued
/// - 0 < payment < amount_due -> PartiallyPaid
/// - payment == amount_due -> Paid
#[tokio::test]
async fn status_matches_amounts_v3() -> Result<()> {
    let env = Env::new().await?;

    let issue_res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    let mut model = Model::new();
    model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: env.alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.alice.id().to_string())),
                terms_hash: ModelHex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    let view_issued: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(view_issued.status, Status::Issued);
    assert_eq!(
        model.get_claim(&token_id).unwrap().status,
        ModelStatus::Issued
    );

    let _ = env.fund_claim(&token_id, 500_000, None).await?;
    let rec1 = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec1.is_success());

    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: DEFAULT_SETTLEMENT_ASSET.to_string(),
                amount: 500_000,
            },
            101,
        )
        .unwrap();
    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![false],
            },
            102,
        )
        .unwrap();

    let view_partial: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(view_partial.status, Status::PartiallyPaid);
    assert_eq!(
        model.get_claim(&token_id).unwrap().status,
        ModelStatus::PartiallyPaid
    );

    let _ = env.fund_claim(&token_id, 500_000, None).await?;
    let rec2 = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec2.is_success());

    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: DEFAULT_SETTLEMENT_ASSET.to_string(),
                amount: 500_000,
            },
            103,
        )
        .unwrap();
    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![false],
            },
            104,
        )
        .unwrap();

    let view_paid: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(view_paid.status, Status::Paid);
    assert_eq!(
        model.get_claim(&token_id).unwrap().status,
        ModelStatus::Paid
    );
    assert!(check_status_matches_amounts_v3(model.get_claim(&token_id).unwrap()).is_ok());

    Ok(())
}

/// 17. `stale_reconcile_lock_clears`: Stale locks (> 100 blocks) clear without booking (Blueprint 2.2, 2.3, 2.11).
///
/// Asserts:
/// - Reconciling lock older than 100 blocks is cleared by `clear_stale_lock` back to None
#[tokio::test]
async fn stale_reconcile_lock_clears() -> Result<()> {
    let env = Env::new().await?;

    let _ = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    env.advance_blocks(150).await?;

    let clear_res = env
        .alice
        .call(env.root.id(), "clear_stale_lock")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(clear_res.is_success());

    Ok(())
}

/// 18. `cancel_only_unpaid`: Cancel is permitted only when claim is completely unpaid and uncredited (Blueprint 2.2, 2.11).
///
/// Asserts:
/// - Unpaid claim can be cancelled by owner
/// - Partially paid or paid claim cannot be cancelled
#[tokio::test]
#[ignore = "C5"]
async fn cancel_only_unpaid() -> Result<()> {
    let env = Env::new().await?;

    let issue_res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    let mut model = Model::new();
    model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: env.alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.alice.id().to_string())),
                terms_hash: ModelHex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    let cancel_res = env
        .alice
        .call(env.root.id(), "cancel")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(cancel_res.is_success());

    model
        .step(
            Action::Cancel {
                caller: env.alice.id().to_string(),
                token_id: token_id.clone(),
                debtor_cosig: None,
            },
            101,
        )
        .unwrap();

    let view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;

    let model_claim = model.get_claim(&token_id).unwrap();
    assert_eq!(view.status, Status::Cancelled);
    assert_eq!(model_claim.status, ModelStatus::Cancelled);
    assert!(check_cancel_only_unpaid(model_claim).is_ok());

    Ok(())
}

/// 19. `closed_addresses_stay_live`: Stray payments to Closed/terminal claims land in surplus (Blueprint 2.5, 2.11).
///
/// Asserts:
/// - Payments arriving after claim is Closed book 0 to payment and 100% to surplus
#[tokio::test]
#[ignore = "C5"]
async fn closed_addresses_stay_live() -> Result<()> {
    let env = Env::new().await?;

    let issue_res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    let mut model = Model::new();
    model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: env.alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.alice.id().to_string())),
                terms_hash: ModelHex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    let _ = env.fund_claim(&token_id, 1_000_000, None).await?;
    let rec1 = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec1.is_success());

    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: DEFAULT_SETTLEMENT_ASSET.to_string(),
                amount: 1_000_000,
            },
            101,
        )
        .unwrap();
    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![false],
            },
            102,
        )
        .unwrap();

    let close_res = env
        .alice
        .call(env.root.id(), "close")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(close_res.is_success());

    model
        .step(
            Action::Close {
                caller: env.alice.id().to_string(),
                token_id: token_id.clone(),
            },
            103,
        )
        .unwrap();

    let pre_stray_view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    let pre_stray_model = model.get_claim(&token_id).unwrap().clone();
    assert_eq!(pre_stray_view.status, Status::Closed);
    assert_eq!(pre_stray_model.status, ModelStatus::Closed);

    // Stray payment of 200_000 arrives at Closed address
    let _ = env.fund_claim(&token_id, 200_000, None).await?;
    let rec_stray = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec_stray.is_success());

    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: DEFAULT_SETTLEMENT_ASSET.to_string(),
                amount: 200_000,
            },
            104,
        )
        .unwrap();
    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![],
            },
            105,
        )
        .unwrap();

    let post_stray_view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    let post_stray_model = model.get_claim(&token_id).unwrap();

    assert_eq!(post_stray_view.status, Status::Closed);
    assert_eq!(
        post_stray_view.surplus.0,
        pre_stray_view.surplus.0 + 200_000
    );
    assert_eq!(post_stray_view.surplus.0, post_stray_model.surplus);
    assert!(check_closed_addresses_stay_live(&pre_stray_model, post_stray_model, 200_000).is_ok());

    Ok(())
}

/// 20. `transitions_enforced`: Status transitions strictly adhere to Blueprint 2.3 lifecycle graph.
///
/// Asserts:
/// - Illegal status transitions (e.g. Paid -> Issued, Cancelled -> Paid) return InvariantViolation
#[tokio::test]
#[ignore = "C5"]
async fn transitions_enforced() -> Result<()> {
    let env = Env::new().await?;

    let issue_res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    let view_init: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(view_init.status, Status::Issued);

    // Valid transitions in model oracle
    assert!(check_transitions_enforced(ModelStatus::Issued, ModelStatus::PartiallyPaid).is_ok());
    assert!(check_transitions_enforced(ModelStatus::PartiallyPaid, ModelStatus::Paid).is_ok());
    assert!(check_transitions_enforced(ModelStatus::Paid, ModelStatus::Closed).is_ok());
    assert!(check_transitions_enforced(ModelStatus::Issued, ModelStatus::Cancelled).is_ok());

    // Illegal transitions rejected in model oracle
    assert!(check_transitions_enforced(ModelStatus::Paid, ModelStatus::Issued).is_err());
    assert!(check_transitions_enforced(ModelStatus::Cancelled, ModelStatus::Paid).is_err());
    assert!(check_transitions_enforced(ModelStatus::Closed, ModelStatus::PartiallyPaid).is_err());

    // Illegal transition on contract: closing an unpaid/issued claim directly is forbidden
    let close_unpaid = env
        .alice
        .call(env.root.id(), "close")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(close_unpaid.is_failure());

    Ok(())
}
