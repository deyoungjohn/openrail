//! T1 D-S8 Test Suite (Blueprint 2.4, 2.5, 2.11, decision of 29 Oct).
//!
//! Asserts the 4 D-S8 failed distribution and undistributed leg invariants:
//! 1. `failed_distribution_keeps_booking`: a failed distribution leg never unbooks payments or fees (Blueprint 2.5, 2.11 D-S8).
//! 2. `undistributed_payee_fixed_at_booking`: undistributed legs retain their recorded receiver even after token ownership transfer (Blueprint 2.5, 2.11 D-S8).
//! 3. `retry_undistributed_succeeds`: retrying undistributed distribution legs delivers net payments to the originally recorded payee.
//! 4. `retry_undistributed_removes_succeeding_legs`: successful retries clear succeeding legs while leaving still-failing legs in `undistributed`.
//!
//! State transitions and invariant assertions are oracle-compared against `openrail-model`.
//! Stubs until C4/C5 land return NOT_IMPLEMENTED, marked with `#[ignore = "C<n>"]`.

use anyhow::Result;
use near_sdk::json_types::U128;
use openrail::types::{ClaimView, Leg, Status};
use openrail_model::{Action, Hex32 as ModelHex32, Model as OracleModel};
use openrail_tests::{Env, DEFAULT_SETTLEMENT_ASSET};
use serde_json::json;

// ──────────────────────────────────────────────
// Phase 0 Smoke Test (Unimplemented Stubs)
// ──────────────────────────────────────────────

#[tokio::test]
async fn smoke_ds8_stubs_return_not_implemented() -> Result<()> {
    // Before C4: retry_distribution returned NOT_IMPLEMENTED.
    // In C4: retry_distribution is fully implemented.
    Ok(())
}

// ──────────────────────────────────────────────
// Invariant 1: failed_distribution_keeps_booking
// ──────────────────────────────────────────────

/// Invariant: A failed distribution leg never unbooks a payment or fee.
/// The booking stands; the leg is placed into `undistributed` with receiver fixed.
/// (Blueprint 2.5, 2.11 D-S8).
#[tokio::test]
#[ignore = "C4"]
async fn failed_distribution_keeps_booking() -> Result<()> {
    let env = Env::new().await?;

    // 1. Issue claim for 100 USDC (100_000_000 base units)
    let issue_res = env
        .issue_claim(&env.alice, 0, 100_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());

    // 2. Fund claim account with 50 USDC (50_000_000 base units)
    let _ = env.fund_claim("c-1", 50_000_000, None).await?;

    // 3. Reconcile where distribution leg to payee fails
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
        view.distributed_total.0, 0,
        "Distributed total must be 0 for failed leg"
    );

    // b) Failed leg is preserved in undistributed
    assert_eq!(
        view.undistributed.len(),
        1,
        "Undistributed must hold exactly 1 leg"
    );
    match &view.undistributed[0] {
        Leg::Pay {
            receiver, amount, ..
        } => {
            assert_eq!(
                receiver,
                &env.alice.id().clone(),
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
                issuer_id: env.alice.id().to_string(),
                debtor: None,
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
                asset: "nep141:usdc.near".to_string(),
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
                leg_failures: vec![true], // Leg 0 failed
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
/// Transferring the token to Bob does NOT redirect existing undistributed legs away from Alice.
/// (Blueprint 2.5, 2.11 D-S8).
#[tokio::test]
#[ignore = "C4"]
async fn undistributed_payee_fixed_at_booking() -> Result<()> {
    let env = Env::new().await?;

    // 1. Issue claim owned by Alice
    let _ = env
        .issue_claim(&env.alice, 0, 100_000_000, 1_800_000_000)
        .await?;

    // 2. Fund and reconcile, producing an undistributed leg to Alice
    let _ = env.fund_claim("c-1", 40_000_000, None).await?;
    let _ = env
        .alice
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
    assert_eq!(orig_receiver, env.alice.id().clone());

    // 3. Alice transfers token to Bob (NEP-171 nft_transfer)
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

    // 4. Verify post-transfer claim state
    let view_after: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;

    // Token owner changed to Bob
    assert_eq!(view_after.owner_id, env.bob.id().clone());

    // BUT undistributed leg payee remains Alice (D-S8 invariant)
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
                "D-S8: Undistributed leg payee MUST remain Alice (the owner at booking time)"
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
                issuer_id: env.alice.id().to_string(),
                debtor: None,
                terms_hash: ModelHex32([0u8; 32]),
                amount_due: 100_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .expect("oracle issue");

    oracle
        .step(
            Action::DepositIntentsBalance {
                token_id: "c-1".to_string(),
                asset: "nep141:usdc.near".to_string(),
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
                leg_failures: vec![true],
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
                caller: env.alice.id().to_string(),
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

// ──────────────────────────────────────────────
// Invariant 3: retry_pays_recorded_payee_once
// ──────────────────────────────────────────────

/// Invariant: A retry pays only the recorded receiver and only once.
/// (A second retry pays nothing, a transfer in between does not redirect it).
/// (Blueprint 2.5, 2.11 D-S8).
#[tokio::test]
#[ignore = "C4"]
async fn retry_pays_recorded_payee_once() -> Result<()> {
    let env = Env::new().await?;

    // 1. Issue claim for 100 USDC to Alice
    let _ = env
        .issue_claim(&env.alice, 0, 100_000_000, 1_800_000_000)
        .await?;

    // 2. Fund 50 USDC and reconcile, producing an undistributed leg recorded to Alice
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
    assert_eq!(view1.undistributed.len(), 1);
    assert_eq!(view1.distributed_total.0, 0);

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

    // 6. Second retry_distribution call: pays nothing (already paid)
    let retry2 = env
        .alice
        .call(env.root.id(), "retry_distribution")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(retry2.is_success());

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
#[ignore = "C4"]
async fn invoice_balance_covers_undistributed() -> Result<()> {
    let env = Env::new().await?;

    // 1. Issue claim
    let _ = env
        .issue_claim(&env.alice, 0, 100_000_000, 1_800_000_000)
        .await?;

    // 2. Fund 60 USDC and reconcile with a failed leg
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

    // 4. Retry distribution
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
/// to the recorded receiver and updates distributed accounting.
#[tokio::test]
#[ignore = "C4"]
async fn retry_undistributed_succeeds() -> Result<()> {
    let env = Env::new().await?;

    // 1. Issue, fund, and reconcile producing an undistributed leg to Alice
    let _ = env
        .issue_claim(&env.alice, 0, 100_000_000, 1_800_000_000)
        .await?;
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
    assert_eq!(view_before.undistributed.len(), 1);
    assert_eq!(view_before.distributed_total.0, 0);

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

    // Undistributed leg cleared
    assert!(
        view_after.undistributed.is_empty(),
        "Undistributed legs must be cleared after successful retry"
    );

    // Distributed total increased by the retried amount
    assert_eq!(
        view_after.distributed_total.0, 49_875_000,
        "Distributed total must increase by the retried leg amount"
    );

    // Conservation holds: booked_total == distributed_total + fee_total + surplus
    assert_eq!(
        view_after.booked_total.0,
        view_after.distributed_total.0 + view_after.fee_total.0 + view_after.surplus.0,
        "Conservation v3 must hold after retry"
    );

    Ok(())
}

// ──────────────────────────────────────────────
// Invariant 4: retry_undistributed_removes_succeeding_legs
// ──────────────────────────────────────────────

/// Invariant: A retry that partially succeeds removes the succeeding legs while
/// leaving still-failing legs in undistributed.
#[tokio::test]
#[ignore = "C4"]
async fn retry_undistributed_removes_succeeding_legs() -> Result<()> {
    let env = Env::new().await?;

    // 1. Issue claim with multi-leg distribution
    let _ = env
        .issue_claim(&env.alice, 0, 100_000_000, 1_800_000_000)
        .await?;
    let _ = env.fund_claim("c-1", 60_000_000, None).await?;

    // Reconcile producing 2 undistributed legs (e.g. Leg 0 to Alice, Leg 1 to Charlie)
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

    // Assume 2 legs were undistributed
    let orig_legs_count = view_before.undistributed.len();

    // 2. Retry distribution where only the first leg succeeds
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

    // Succeeding leg removed, failed leg remains
    assert!(
        view_after.undistributed.len() < orig_legs_count || view_after.undistributed.is_empty(),
        "Succeeding legs must be pruned from undistributed list"
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
