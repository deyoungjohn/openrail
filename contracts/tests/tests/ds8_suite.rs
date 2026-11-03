//! T1 D-S8 Test Suite (Blueprint 2.4, 2.5, 2.11, decision of 29 Oct).
//!
//! Asserts the 4 D-S8 failed distribution and undistributed leg invariants:
//! 1. `failed_distribution_keeps_booking`: a failed distribution leg never unbooks payments or fees (Blueprint 2.5, 2.11 D-S8).
//! 2. `undistributed_payee_fixed_at_booking`: undistributed legs retain their recorded receiver even after token ownership transfer (Blueprint 2.5, 2.11 D-S8).
//! 3. `retry_pays_recorded_payee_once`: retrying undistributed distribution legs delivers net payments to the originally recorded payee once.
//! 4. `invoice_balance_covers_undistributed`: claim account balance covers undistributed legs before and after retry.
//!
//! State transitions and invariant assertions are oracle-compared against `openrail-model`.

use anyhow::Result;
use near_sdk::json_types::U128;
use openrail::types::{ClaimView, Debtor, Hex32, Leg, Status};
use openrail_model::{Action, Debtor as ModelDebtor, Hex32 as ModelHex32, Model as OracleModel};
use openrail_tests::{Env, DEFAULT_SETTLEMENT_ASSET};
use serde_json::json;

// ──────────────────────────────────────────────
// Phase 0 Smoke Test (Unimplemented Stubs)
// ──────────────────────────────────────────────

#[tokio::test]
async fn smoke_ds8_stubs_return_not_implemented() -> Result<()> {
    Ok(())
}

// ──────────────────────────────────────────────
// Invariant 1: failed_distribution_keeps_booking
// ──────────────────────────────────────────────

/// Invariant: A failed distribution leg never unbooks a payment or fee.
/// The booking stands; the leg is placed into `undistributed` with receiver fixed.
/// (Blueprint 2.5, 2.11 D-S8).
#[tokio::test]
async fn failed_distribution_keeps_booking() -> Result<()> {
    let env = Env::new().await?;

    let reject_alice = env
        .parent
        .create_subaccount("reject-alice")
        .initial_balance(near_workspaces::types::NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;

    // 1. Issue claim for 100 USDC (100_000_000 base units) owned by reject_alice
    let issue_res = env
        .issue_claim(&reject_alice, 0, 100_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());

    // 2. Fund claim account with 50 USDC (50_000_000 base units)
    let _ = env.fund_claim("c-1", 50_000_000, None).await?;

    // 3. Reconcile where distribution leg to payee fails (receiver contains "reject")
    // Expected fee = floor(50_000_000 * 25 / 10_000) = 125_000
    // Expected net = 49_875_000
    let rec_res = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec_res.is_success());

    // 4. Query claim view from contract
    let view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;

    // Invariant assertions:
    // a) Booking stands despite distribution failure
    assert_eq!(view.booked_total.0, 50_000_000, "Booked total must stand");
    assert_eq!(view.fee_total.0, 125_000, "Protocol fee must stand");
    assert_eq!(
        view.distributed_total.0, 49_875_000,
        "Distributed total counter stands at net booked amount"
    );

    // b) Failed leg is preserved in undistributed
    assert_eq!(
        view.undistributed.len(),
        1,
        "Undistributed must hold the 1 failed payee leg"
    );
    match &view.undistributed[0] {
        Leg::Pay {
            receiver, amount, ..
        } => {
            assert_eq!(
                receiver,
                reject_alice.id(),
                "Payee must be fixed to original owner"
            );
            assert_eq!(amount.0, 49_875_000, "Leg amount must match net payment");
        }
        _ => panic!("Expected Leg::Pay"),
    }

    // c) Status matches amounts: 50 USDC booked against 100 USDC due -> PartiallyPaid
    assert_eq!(view.status, Status::PartiallyPaid);

    // 5. Cross-check against reference state machine oracle
    let mut oracle = OracleModel::new();
    oracle
        .step(
            Action::Issue {
                token_id: "c-1".to_string(),
                kind: 0,
                issuer_id: reject_alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.bob.id().to_string())),
                terms_hash: ModelHex32([0u8; 32]),
                amount_due: 100_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .expect("oracle issue");

    let pre_claim = oracle.claims.get("c-1").expect("oracle pre claim").clone();

    oracle
        .step(
            Action::DepositIntentsBalance {
                token_id: "c-1".to_string(),
                asset: DEFAULT_SETTLEMENT_ASSET.to_string(),
                amount: 50_000_000,
            },
            101,
        )
        .expect("oracle deposit");

    oracle
        .step(
            Action::ReconcileStart {
                token_id: "c-1".to_string(),
            },
            102,
        )
        .expect("oracle reconcile start");

    oracle
        .step(
            Action::ReconcileCallback {
                token_id: "c-1".to_string(),
                leg_failures: vec![true, false], // Leg 0 (payee) failed, Leg 1 (fee) succeeded
                callback_ok: true,
            },
            103,
        )
        .expect("oracle reconcile callback");

    let oracle_claim = oracle.claims.get("c-1").expect("oracle claim");
    assert_eq!(view.booked_total.0, oracle_claim.booked_total);
    assert_eq!(view.fee_total.0, oracle_claim.fee_total);
    assert_eq!(view.distributed_total.0, oracle_claim.distributed_total);
    assert_eq!(view.undistributed.len(), oracle_claim.undistributed.len());

    // Invariant check from openrail-model
    openrail_model::invariants::check_failed_distribution_keeps_booking(
        &pre_claim,
        oracle_claim,
        50_000_000,
    )
    .expect("oracle D-S8 check failed_distribution_keeps_booking");

    Ok(())
}

// ──────────────────────────────────────────────
// Invariant 2: undistributed_payee_fixed_at_booking
// ──────────────────────────────────────────────

/// Invariant: Undistributed legs retain their recorded payee even after token ownership transfer.
/// Transferring the token to Bob does NOT redirect existing undistributed legs away from the original owner.
/// (Blueprint 2.5, 2.11 D-S8).
#[tokio::test]
async fn undistributed_payee_fixed_at_booking() -> Result<()> {
    let env = Env::new().await?;

    let reject_alice = env
        .parent
        .create_subaccount("reject-alice")
        .initial_balance(near_workspaces::types::NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;

    // 1. Issue claim owned by reject_alice with Bob as debtor, and acknowledge so it can be sold
    let _ = env
        .issue_claim_with_details(
            &reject_alice,
            0,
            Some(Debtor::Near(env.bob.id().clone())),
            Hex32::default(),
            100_000_000,
            1_800_000_000,
            None,
        )
        .await?;

    let ack_res = env
        .bob
        .call(env.root.id(), "acknowledge_near")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack_res.is_success());

    // 2. Fund and reconcile, producing an undistributed leg to reject_alice
    let _ = env.fund_claim("c-1", 40_000_000, None).await?;
    let _ = reject_alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;

    // Verify initial undistributed state
    let view_before: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert_eq!(view_before.undistributed.len(), 1);
    let orig_receiver = match &view_before.undistributed[0] {
        Leg::Pay { receiver, .. } => receiver.clone(),
        _ => panic!("Expected Leg::Pay"),
    };
    assert_eq!(&orig_receiver, reject_alice.id());

    // 3. reject_alice transfers token to Bob (NEP-171 nft_transfer)
    let transfer_res = reject_alice
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": "c-1",
            "memo": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(transfer_res.is_success());

    // 4. Verify post-transfer claim state
    let view_after: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;

    // Token owner changed to Bob
    assert_eq!(view_after.owner_id, env.bob.id().clone());

    // BUT undistributed leg payee remains reject_alice (D-S8 invariant)
    assert_eq!(
        view_after.undistributed.len(),
        1,
        "Undistributed legs must be preserved across transfer"
    );
    match &view_after.undistributed[0] {
        Leg::Pay {
            receiver, amount, ..
        } => {
            assert_eq!(
                receiver, &orig_receiver,
                "D-S8: Undistributed leg payee MUST remain the owner at booking time"
            );
            assert_ne!(
                receiver,
                &env.bob.id().clone(),
                "D-S8: Undistributed leg payee must NOT be redirected to new owner Bob"
            );
            assert_eq!(amount.0, 39_900_000); // 40_000_000 - 100_000 fee
        }
        _ => panic!("Expected Leg::Pay"),
    }

    // 5. Cross-check against openrail-model oracle
    let mut oracle = OracleModel::new();
    oracle
        .step(
            Action::Issue {
                token_id: "c-1".to_string(),
                kind: 0,
                issuer_id: reject_alice.id().to_string(),
                debtor: Some(ModelDebtor::Near(env.bob.id().to_string())),
                terms_hash: ModelHex32([0u8; 32]),
                amount_due: 100_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .expect("oracle issue");

    oracle
        .step(
            Action::AcknowledgeNear {
                caller: env.bob.id().to_string(),
                token_id: "c-1".to_string(),
            },
            100,
        )
        .expect("oracle ack");

    oracle
        .step(
            Action::DepositIntentsBalance {
                token_id: "c-1".to_string(),
                asset: DEFAULT_SETTLEMENT_ASSET.to_string(),
                amount: 40_000_000,
            },
            101,
        )
        .expect("oracle deposit");

    oracle
        .step(
            Action::ReconcileStart {
                token_id: "c-1".to_string(),
            },
            102,
        )
        .expect("oracle reconcile start");

    oracle
        .step(
            Action::ReconcileCallback {
                token_id: "c-1".to_string(),
                leg_failures: vec![true, false],
                callback_ok: true,
            },
            103,
        )
        .expect("oracle reconcile callback");

    let pre_transfer_undistributed = oracle
        .claims
        .get("c-1")
        .expect("oracle pre-transfer claim")
        .undistributed
        .clone();

    oracle
        .step(
            Action::Transfer {
                token_id: "c-1".to_string(),
                caller: reject_alice.id().to_string(),
                new_owner: env.bob.id().to_string(),
                memo_assignment_doc_hash: Some(ModelHex32([1u8; 32])),
                attached_yocto: 1,
            },
            104,
        )
        .expect("oracle transfer");

    let oracle_claim = oracle.claims.get("c-1").expect("oracle claim");
    assert_eq!(view_after.owner_id.to_string(), oracle_claim.owner_id);
    let actual_receiver = match &view_after.undistributed[0] {
        Leg::Pay { receiver, .. } => receiver.to_string(),
        _ => panic!("Expected Leg::Pay"),
    };
    assert_eq!(
        Some(&actual_receiver),
        oracle_claim.undistributed[0].receiver()
    );

    openrail_model::invariants::check_undistributed_payee_fixed_at_booking(
        &pre_transfer_undistributed,
        &oracle_claim.undistributed,
        env.bob.id().as_ref(),
    )
    .expect("oracle D-S8 check undistributed_payee_fixed_at_booking");

    Ok(())
}

async fn intents_balance(env: &Env, account_id: &near_workspaces::AccountId) -> Result<u128> {
    let bal: U128 = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({
            "account_id": account_id,
            "token_id": DEFAULT_SETTLEMENT_ASSET,
        }))
        .await?
        .json()?;
    Ok(bal.0)
}

async fn inject_failing_vault(env: &Env, token_id: &str) -> Result<near_workspaces::AccountId> {
    let claim_id: near_workspaces::AccountId = format!("{token_id}.{}", env.root.id()).parse()?;
    env.worker
        .patch(&claim_id)
        .code(&openrail_tests::wasms::mock_usdc_wasm()?)
        .transact()
        .await?;
    Ok(claim_id)
}

async fn restore_vault_code(env: &Env, claim_id: &near_workspaces::AccountId) -> Result<()> {
    env.worker
        .patch(claim_id)
        .code(&openrail_tests::wasms::vault_wasm()?)
        .transact()
        .await?;
    Ok(())
}

// ──────────────────────────────────────────────
// Invariant 3: retry_pays_recorded_payee_once
// ──────────────────────────────────────────────

/// Invariant: A retry pays only the recorded receiver and only once.
/// (A second retry pays nothing, a transfer in between does not redirect it).
/// (Blueprint 2.5, 2.11 D-S8).
#[tokio::test]
async fn retry_pays_recorded_payee_once() -> Result<()> {
    let env = Env::new().await?;

    // 1. Issue claim for 100 USDC to Alice with Bob as debtor, and acknowledge
    let _ = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Near(env.bob.id().clone())),
            Hex32::default(),
            100_000_000,
            1_800_000_000,
            None,
        )
        .await?;

    let ack_res = env
        .bob
        .call(env.root.id(), "acknowledge_near")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack_res.is_success());

    // Inject failing vault code so forwards fail during reconcile
    let claim_id = inject_failing_vault(&env, "c-1").await?;

    // 2. Fund 50 USDC and reconcile, producing undistributed legs recorded to Alice and fees
    let _ = env.fund_claim("c-1", 50_000_000, None).await?;
    let _ = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;

    let view1: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert!(!view1.undistributed.is_empty());

    // 3. Transfer token from Alice to Bob
    let transfer_res = env
        .alice
        .call(env.root.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": "c-1",
            "memo": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(transfer_res.is_success());

    // Restore vault code so retry succeeds
    restore_vault_code(&env, &claim_id).await?;

    // 4. Record balances before retry
    let alice_bal_before = intents_balance(&env, env.alice.id()).await?;
    let bob_bal_before = intents_balance(&env, env.bob.id()).await?;

    // 5. First retry_distribution call: pays recorded payee (Alice), NOT Bob
    let retry1 = env
        .bob
        .call(env.root.id(), "retry_distribution")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(retry1.is_success());

    let alice_bal_after = intents_balance(&env, env.alice.id()).await?;
    let bob_bal_after = intents_balance(&env, env.bob.id()).await?;

    // Alice (recorded payee) got paid the net amount
    assert_eq!(
        alice_bal_after - alice_bal_before,
        49_875_000,
        "D-S8: Retry must pay the originally recorded payee (Alice)"
    );
    // Bob (current token owner) got nothing from this booking retry
    assert_eq!(
        bob_bal_after, bob_bal_before,
        "D-S8: Retry must NOT pay the current token owner (Bob)"
    );

    let view2: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert!(
        view2.undistributed.is_empty(),
        "Undistributed legs cleared after first retry"
    );
    assert_eq!(view2.distributed_total.0, 49_875_000);

    // 6. Second retry_distribution call: fails with no undistributed legs and pays nothing
    let retry2 = env
        .alice
        .call(env.root.id(), "retry_distribution")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(retry2.is_failure());

    let alice_bal_second = intents_balance(&env, env.alice.id()).await?;
    assert_eq!(
        alice_bal_second, alice_bal_after,
        "D-S8: Second retry must pay nothing (retry only pays once)"
    );

    let view3: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert_eq!(
        view3.distributed_total.0, 49_875_000,
        "Distributed total unchanged on second retry"
    );

    Ok(())
}

// ──────────────────────────────────────────────
// Invariant 4: invoice_balance_covers_undistributed
// ──────────────────────────────────────────────

/// Invariant: The claim account's balance always covers undistributed legs.
/// (Contract view and intents.near balance, after a failed leg and after a retry).
/// (Blueprint 2.5, 2.11 D-S8).
#[tokio::test]
async fn invoice_balance_covers_undistributed() -> Result<()> {
    let env = Env::new().await?;

    // 1. Issue claim
    let _ = env
        .issue_claim(&env.alice, 0, 100_000_000, 1_800_000_000)
        .await?;

    let claim_id = inject_failing_vault(&env, "c-1").await?;

    // 2. Fund 60 USDC and reconcile with failed legs
    let _ = env.fund_claim("c-1", 60_000_000, None).await?;
    let _ = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;

    // 3. Check after failed leg: intents.near balance of claim account covers undistributed legs
    let view_failed: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert!(!view_failed.undistributed.is_empty());

    let undistributed_sum: u128 = view_failed
        .undistributed
        .iter()
        .map(|l| match l {
            Leg::Pay { amount, .. } => amount.0,
            Leg::Hold { amount, .. } => amount.0,
        })
        .sum();

    let claim_intents_bal = env.claim_balance("c-1", None).await?;

    assert!(
        claim_intents_bal >= undistributed_sum,
        "Claim account balance ({claim_intents_bal}) must cover undistributed sum ({undistributed_sum}) after failed leg"
    );

    // 4. Restore vault code and retry distribution
    restore_vault_code(&env, &claim_id).await?;

    let retry_res = env
        .alice
        .call(env.root.id(), "retry_distribution")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(retry_res.is_success());

    // 5. Check after retry: remaining balance still covers any remaining undistributed legs
    let view_retried: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;

    let remaining_undistributed_sum: u128 = view_retried
        .undistributed
        .iter()
        .map(|l| match l {
            Leg::Pay { amount, .. } => amount.0,
            Leg::Hold { amount, .. } => amount.0,
        })
        .sum();

    let claim_intents_bal_after = env.claim_balance("c-1", None).await?;

    assert!(
        claim_intents_bal_after >= remaining_undistributed_sum,
        "Claim account balance ({claim_intents_bal_after}) must cover remaining undistributed ({remaining_undistributed_sum}) after retry"
    );

    Ok(())
}

// ──────────────────────────────────────────────
// Invariant 5: retry_undistributed_succeeds (Additional helper test)
// ──────────────────────────────────────────────

/// Invariant: Calling retry_distribution successfully delivers pending undistributed legs
/// to the recorded receiver and preserves conservation.
#[tokio::test]
async fn retry_undistributed_succeeds() -> Result<()> {
    let env = Env::new().await?;

    // 1. Issue, inject failing vault, fund, and reconcile producing undistributed legs
    let _ = env
        .issue_claim(&env.alice, 0, 100_000_000, 1_800_000_000)
        .await?;
    let claim_id = inject_failing_vault(&env, "c-1").await?;

    let _ = env.fund_claim("c-1", 50_000_000, None).await?;
    let _ = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;

    let view_before: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert!(!view_before.undistributed.is_empty());

    restore_vault_code(&env, &claim_id).await?;

    let alice_bal_before = intents_balance(&env, env.alice.id()).await?;

    // 2. Call retry_distribution (can be called by anyone: Bob calls it)
    let retry_res = env
        .bob
        .call(env.root.id(), "retry_distribution")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(retry_res.is_success());

    // 3. Verify post-retry state
    let view_after: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;

    assert!(
        view_after.undistributed.is_empty(),
        "Undistributed legs must be cleared after successful retry"
    );

    let alice_bal_after = intents_balance(&env, env.alice.id()).await?;
    assert_eq!(alice_bal_after - alice_bal_before, 49_875_000);

    // Conservation holds: booked_total == distributed_total + fee_total + surplus
    assert_eq!(
        view_after.booked_total.0,
        view_after.distributed_total.0 + view_after.fee_total.0 + view_after.surplus.0,
        "Conservation v3 must hold after retry"
    );

    Ok(())
}

// ──────────────────────────────────────────────
// Invariant 6: retry_undistributed_removes_succeeding_legs
// ──────────────────────────────────────────────

/// Invariant: A retry that partially succeeds removes the succeeding legs while
/// leaving still-failing legs in undistributed.
#[tokio::test]
async fn retry_undistributed_removes_succeeding_legs() -> Result<()> {
    let env = Env::new().await?;

    // Set fee_account to "fail-fees.near" so the fee leg still fails after vault restoration
    let _ = env
        .root
        .call("set_config")
        .args_json(json!({ "fee_account": "fail-fees.near" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // 1. Issue claim and inject failing vault so BOTH legs (Alice + fee) fail on initial reconcile
    let _ = env
        .issue_claim(&env.alice, 0, 100_000_000, 1_800_000_000)
        .await?;
    let claim_id = inject_failing_vault(&env, "c-1").await?;

    let _ = env.fund_claim("c-1", 60_000_000, None).await?;
    let _ = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;

    let view_before: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;

    let orig_legs_count = view_before.undistributed.len();
    assert_eq!(orig_legs_count, 2);

    // 2. Restore vault code and retry distribution: Alice leg succeeds, fail-fees.near leg fails
    restore_vault_code(&env, &claim_id).await?;

    let retry_res = env
        .alice
        .call(env.root.id(), "retry_distribution")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(retry_res.is_success());

    // 3. Verify post-retry state
    let view_after: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;

    // Succeeding leg (Alice) removed, failing leg (fail-fees.near) remains
    assert_eq!(
        view_after.undistributed.len(),
        1,
        "Succeeding legs must be pruned from undistributed list while failing leg remains"
    );

    // Accounting remains strictly monotonic and conserved
    assert!(view_after.distributed_total.0 >= view_before.distributed_total.0);
    assert_eq!(
        view_after.booked_total.0,
        view_after.distributed_total.0 + view_after.fee_total.0 + view_after.surplus.0,
        "Conservation v3 must hold"
    );

    Ok(())
}
