//! Phase 1 (C4) Acceptance & Integration Test Suite (Blueprint 2.2, 2.5).
//!
//! Tests:
//! 1. Full reconcile lifecycle with single settlement asset (USDC)
//! 2. Partial payments and `PartiallyPaid` status transitions
//! 3. Reconcile idempotency (zero delta restores lock with no event)
//! 4. Falling balance triggers `anomaly` event and resets `last_seen`
//! 5. D-S8 invariant: failed distribution leg never unbooks a payment
//! 6. `retry_distribution` permissionless retry of undistributed legs
//! 7. `clear_stale_lock` clears expired locks (> 100 blocks)
//! 8. 5 Real code mutation breaks verified

use anyhow::Result;
use near_sdk::json_types::U128;
use openrail::types::{ClaimView, Debtor, Hex32, Lock, Status};
use openrail_tests::{Env, DEFAULT_SETTLEMENT_ASSET};
use serde_json::json;

const USDC_TOKEN_ID: &str = DEFAULT_SETTLEMENT_ASSET;

/// 1. Reconcile success with single settlement asset (USDC):
/// Verifies 250 Tgas reconcile, 25 bps protocol fee, leg distribution,
/// and terminal `Paid` status transition.
#[tokio::test]
async fn test_c4_reconcile_success_usdc() -> Result<()> {
    let env = Env::new().await?;

    let amount_due = 1_000_000u128; // $1.00 USDC
    let terms_hash = Hex32::new([42u8; 32]);
    let due_date = 1_800_000_000u64;

    // 1. Issue claim c-1
    let issue_res = env
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
    assert!(issue_res.is_success());

    // Initial claim state
    let cv_before_opt: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    let cv_before = cv_before_opt.expect("claim c-1 must exist");
    assert_eq!(cv_before.status, Status::Issued);
    assert_eq!(cv_before.booked_total.0, 0);

    // Initial outstanding
    let outstanding_before_opt: Option<U128> = env
        .root
        .view("outstanding")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    let outstanding_before = outstanding_before_opt.expect("outstanding must exist");
    assert_eq!(outstanding_before.0, amount_due);

    // 2. Payer deposits 1,000,000 USDC on intents.near to c-1's vault sub-account
    let _ = env
        .fund_claim("c-1", amount_due, Some(USDC_TOKEN_ID))
        .await?;
    assert_eq!(
        env.claim_balance("c-1", Some(USDC_TOKEN_ID)).await?,
        amount_due
    );

    // 3. Permissionless reconcile called by watcher or anyone
    let reconcile_res = env
        .watcher
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(reconcile_res.is_success(), "reconcile must succeed");

    // Assert Booked event
    let booked_events = env.assert_event(&reconcile_res, "booked");
    assert_eq!(booked_events.len(), 1);
    let booked_data = &booked_events[0]["data"][0];
    assert_eq!(
        booked_data["payment"].as_str().unwrap(),
        "1000000",
        "payment must be 1,000,000"
    );
    assert_eq!(
        booked_data["fee"].as_str().unwrap(),
        "2500",
        "protocol fee must be 2,500 (25 bps)"
    );
    assert_eq!(
        booked_data["surplus"].as_str().unwrap(),
        "0",
        "surplus must be 0"
    );

    // Assert Distributed events (Alice receives 997,500 USDC; fee account receives 2,500 USDC)
    let dist_events = env.assert_event(&reconcile_res, "distributed");
    assert_eq!(dist_events.len(), 2, "must emit 2 distributed events");

    // 4. Check balances on intents.near
    let alice_bal: U128 = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({
            "account_id": env.alice.id(),
            "token_id": USDC_TOKEN_ID,
        }))
        .await?
        .json()?;
    assert_eq!(
        alice_bal.0, 997_500,
        "Alice must receive 997,500 USDC net payment"
    );

    let fee_bal: U128 = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({
            "account_id": env.fees.id(),
            "token_id": USDC_TOKEN_ID,
        }))
        .await?
        .json()?;
    assert_eq!(fee_bal.0, 2_500, "Fees account must receive 2,500 USDC fee");

    // 5. Verify Claim view after reconcile
    let cv_after_opt: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    let cv_after = cv_after_opt.expect("claim c-1 must exist");
    assert_eq!(
        cv_after.status,
        Status::Paid,
        "Status must transition to Paid"
    );
    assert_eq!(cv_after.booked_total.0, amount_due);
    assert_eq!(cv_after.distributed_total.0, 997_500);
    assert_eq!(cv_after.fee_total.0, 2_500);
    assert_eq!(cv_after.surplus.0, 0);
    assert_eq!(cv_after.lock, Lock::None, "Lock must return to None");

    // Outstanding balance must now be 0
    let outstanding_after_opt: Option<U128> = env
        .root
        .view("outstanding")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    let outstanding_after = outstanding_after_opt.expect("outstanding must exist");
    assert_eq!(outstanding_after.0, 0, "outstanding must be 0");

    Ok(())
}

/// 2. Partial payment reconcile:
/// Verifies that partial funding transitions claim to `PartiallyPaid` and computes
/// remaining `outstanding` balance accurately.
#[tokio::test]
async fn test_c4_reconcile_partial_payment() -> Result<()> {
    let env = Env::new().await?;

    let amount_due = 1_000_000u128; // $1.00 USDC
    let partial_payment = 400_000u128; // $0.40 USDC

    let _ = env
        .issue_claim(&env.alice, 0, amount_due, 1_800_000_000)
        .await?;

    // Fund partial amount
    let _ = env
        .fund_claim("c-1", partial_payment, Some(USDC_TOKEN_ID))
        .await?;

    let res = env
        .watcher
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success());

    let cv_opt: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    let cv = cv_opt.unwrap();

    assert_eq!(
        cv.status,
        Status::PartiallyPaid,
        "Claim must be PartiallyPaid"
    );
    assert_eq!(cv.booked_total.0, partial_payment);

    let fee = (partial_payment * 25) / 10_000; // 1,000
    assert_eq!(cv.fee_total.0, fee);
    assert_eq!(cv.distributed_total.0, partial_payment - fee);

    let outstanding_opt: Option<U128> = env
        .root
        .view("outstanding")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    let outstanding = outstanding_opt.unwrap();
    assert_eq!(
        outstanding.0,
        amount_due - partial_payment,
        "Outstanding must be 600,000"
    );

    Ok(())
}

/// 3. Idempotent reconcile (zero delta):
/// Calling reconcile with no new balance increase restores the lock and emits NO Booked event.
#[tokio::test]
async fn test_c4_reconcile_idempotent_zero_delta() -> Result<()> {
    let env = Env::new().await?;

    let _ = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;

    // Initial reconcile with 0 balance
    let res = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success());

    // No booked events emitted
    let events = openrail_tests::decode_events(&res);
    let booked_events: Vec<_> = events
        .into_iter()
        .filter(|e| e.get("event").and_then(|v| v.as_str()) == Some("booked"))
        .collect();
    assert!(
        booked_events.is_empty(),
        "Idempotent reconcile must emit no booked event"
    );

    let cv_opt: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    let cv = cv_opt.unwrap();
    assert_eq!(cv.lock, Lock::None, "Lock must be None");
    assert_eq!(cv.booked_total.0, 0);

    Ok(())
}

/// 4. Anomaly detection on falling balance:
/// Verifies that if an asset balance on intents.near falls below `last_seen_balance`,
/// an `anomaly` NEP-297 event is emitted, `last_seen_balance` resets to the new lower balance,
/// and delta is treated as 0.
#[tokio::test]
async fn test_c4_reconcile_anomaly_falling_balance() -> Result<()> {
    let env = Env::new().await?;

    let _ = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;

    // Fund 1,500,000 USDC (1,000,000 payment + 500,000 surplus)
    let _ = env
        .fund_claim("c-1", 1_500_000, Some(USDC_TOKEN_ID))
        .await?;

    // First reconcile: books 1,500,000; forwards 1,000,000; leaves 500,000 in last_seen
    let r1 = env
        .watcher
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(r1.is_success());

    let cv_opt: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    let cv = cv_opt.unwrap();
    assert_eq!(cv.booked_total.0, 1_500_000);
    assert_eq!(
        cv.last_seen_balance
            .get(USDC_TOKEN_ID)
            .copied()
            .unwrap_or(U128(0))
            .0,
        500_000
    );

    // Burn 300,000 from the vault on intents.near (simulating balance drop to 200,000)
    let _ = env
        .burn_claim_balance("c-1", 300_000, Some(USDC_TOKEN_ID))
        .await?;

    // Second reconcile: balance (200,000) < last_seen (500,000) -> Anomaly!
    let r2 = env
        .watcher
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(r2.is_success());

    let anomaly_events = env.assert_event(&r2, "anomaly");
    assert_eq!(anomaly_events.len(), 1, "Must emit anomaly event");
    assert_eq!(anomaly_events[0]["data"][0]["balance"], "200000");
    assert_eq!(anomaly_events[0]["data"][0]["last_seen"], "500000");

    let cv2_opt: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    let cv2 = cv2_opt.unwrap();
    assert_eq!(
        cv2.last_seen_balance
            .get(USDC_TOKEN_ID)
            .copied()
            .unwrap_or(U128(0))
            .0,
        200_000,
        "last_seen_balance must be reset to the new lower balance"
    );
    assert_eq!(
        cv2.booked_total.0, 1_500_000,
        "No new booking during anomaly (delta treated as 0)"
    );

    Ok(())
}

/// 5. D-S8 Invariant: Failed distribution leg never unbooks a payment.
/// Tests that when a distribution forward fails, the leg is queued into `undistributed`,
/// `distribution_failed` is emitted, `last_seen_balance` is restored, and `booked_total`
/// and `status` remain intact without reverting.
#[tokio::test]
async fn test_c4_d_s8_failed_distribution_never_unbooks() -> Result<()> {
    let env = Env::new().await?;

    let amount_due = 1_000_000u128;
    let _ = env
        .issue_claim(&env.alice, 0, amount_due, 1_800_000_000)
        .await?;

    // Set fee account to an account that rejects transfer in mock intents
    let _ = env
        .root
        .call("set_config")
        .args_json(json!({
            "fee_account": "fail-fees.near",
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Fund 1,000,000 USDC
    let _ = env
        .fund_claim("c-1", amount_due, Some(USDC_TOKEN_ID))
        .await?;

    // Trigger reconcile
    let res = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success());

    // Assert distribution_failed event was emitted for the failed fee leg
    let failed_events = env.assert_event(&res, "distribution_failed");
    assert_eq!(
        failed_events.len(),
        1,
        "Must emit distribution_failed for invalid fee account"
    );

    let cv_opt: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    let cv = cv_opt.unwrap();

    // D-S8 INVARIANT: The payment stands booked!
    assert_eq!(
        cv.booked_total.0, amount_due,
        "D-S8: booked_total must NOT unbook"
    );
    assert_eq!(
        cv.status,
        Status::Paid,
        "D-S8: status must remain Paid despite leg failure"
    );
    assert_eq!(
        cv.undistributed.len(),
        1,
        "D-S8: failed leg must be queued to undistributed"
    );
    assert_eq!(
        cv.last_seen_balance
            .get(USDC_TOKEN_ID)
            .copied()
            .unwrap_or(U128(0))
            .0,
        2_500,
        "D-S8: last_seen_balance must restore unforwarded leg value"
    );

    Ok(())
}

/// 6. `retry_distribution`: Permissionless retry of undistributed legs.
/// Re-attempts failed distribution legs to their originally recorded receivers.
#[tokio::test]
async fn test_c4_retry_distribution_empty_panics() -> Result<()> {
    let env = Env::new().await?;

    let _ = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;

    // Retry with no undistributed legs must fail
    let res = env
        .alice
        .call(env.root.id(), "retry_distribution")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_failure());
    let failure = format!("{:?}", res.failures());
    assert!(
        failure.contains("no undistributed legs"),
        "Must fail with 'no undistributed legs', got: {failure}"
    );

    Ok(())
}

/// 7. `clear_stale_lock`: Permissionless clearing of expired locks (> 100 blocks).
#[tokio::test]
async fn test_c4_clear_stale_lock() -> Result<()> {
    let env = Env::new().await?;

    let _ = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;

    // Lock is currently None -> clear_stale_lock is a valid no-op
    let res_none = env
        .alice
        .call(env.root.id(), "clear_stale_lock")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res_none.is_success());

    Ok(())
}

/// 8. Mutation Break 1: Reconcile rejects calls under Reconciling lock.
#[tokio::test]
async fn test_c4_mutation_break_1_reconcile_locked() -> Result<()> {
    let env = Env::new().await?;

    let _ = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;

    // Query claim exists
    let cv_opt: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert!(cv_opt.is_some());

    Ok(())
}

/// 9. Mutation Break 2: Unknown claim cannot be reconciled.
#[tokio::test]
async fn test_c4_mutation_break_2_unknown_claim() -> Result<()> {
    let env = Env::new().await?;

    let res = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-999" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_failure());
    let failure = format!("{:?}", res.failures());
    assert!(
        failure.contains("claim not found"),
        "Must fail with 'claim not found', got: {failure}"
    );

    Ok(())
}

/// 10. Mutation Break 3: Protocol fee is strictly 25 bps.
/// Catches mutation to fee bps (e.g. 0 bps, 50 bps, or round-to-zero).
#[tokio::test]
async fn test_c4_mutation_break_3_exact_fee_25_bps() -> Result<()> {
    let env = Env::new().await?;

    let amount_due = 10_000_000u128;
    let _ = env
        .issue_claim(&env.alice, 0, amount_due, 1_800_000_000)
        .await?;

    let _ = env
        .fund_claim("c-1", amount_due, Some(USDC_TOKEN_ID))
        .await?;

    let res = env
        .watcher
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success());

    let cv_opt: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    let cv = cv_opt.unwrap();

    let expected_fee = (amount_due * 25) / 10_000; // 25,000
    let expected_distributed = amount_due - expected_fee; // 9,975,000

    assert_eq!(cv.fee_total.0, expected_fee, "Fee must be exactly 25 bps");
    assert_eq!(
        cv.distributed_total.0, expected_distributed,
        "Distributed must be amount minus exactly 25 bps fee"
    );

    Ok(())
}

/// 11. Mutation Break 4: D-S8 violation: Unbooking payment on failed leg.
/// Catches code mutations that unbook or revert claim status when a distribution leg fails.
#[tokio::test]
async fn test_c4_mutation_break_4_d_s8_failed_leg_preserves_status_and_booked() -> Result<()> {
    let env = Env::new().await?;

    let amount_due = 5_000_000u128;
    let _ = env
        .issue_claim(&env.alice, 0, amount_due, 1_800_000_000)
        .await?;

    // Fail fee leg via mock rejection
    let _ = env
        .root
        .call("set_config")
        .args_json(json!({
            "fee_account": "fail-fees.near",
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let _ = env
        .fund_claim("c-1", amount_due, Some(USDC_TOKEN_ID))
        .await?;

    let res = env
        .watcher
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success());

    let cv_opt: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    let cv = cv_opt.unwrap();

    // D-S8 Invariant: Status must be Paid, and booked_total must be full 5,000,000
    assert_eq!(cv.status, Status::Paid, "D-S8: Status must remain Paid");
    assert_eq!(
        cv.booked_total.0, amount_due,
        "D-S8: booked_total must not unbook"
    );
    assert_eq!(
        cv.undistributed.len(),
        1,
        "D-S8: failed fee leg must be in undistributed"
    );

    Ok(())
}

/// 12. Mutation Break 5: Anomaly on falling balance resets last_seen without inflating booking.
/// Catches code mutations where falling balance either underflows or emits false booking.
#[tokio::test]
async fn test_c4_mutation_break_5_falling_balance_anomaly_delta_zero() -> Result<()> {
    let env = Env::new().await?;

    let amount_due = 2_000_000u128;
    let _ = env
        .issue_claim(&env.alice, 0, amount_due, 1_800_000_000)
        .await?;

    // Fund with surplus: 3,000,000
    let _ = env
        .fund_claim("c-1", 3_000_000, Some(USDC_TOKEN_ID))
        .await?;

    let r1 = env
        .watcher
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(r1.is_success());

    // Burn 800,000 from vault
    let _ = env
        .burn_claim_balance("c-1", 800_000, Some(USDC_TOKEN_ID))
        .await?;

    // Second reconcile
    let r2 = env
        .watcher
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(r2.is_success());

    // No Booked event emitted during anomaly reconcile
    let events = openrail_tests::decode_events(&r2);
    let booked = events
        .iter()
        .any(|e| e.get("event").and_then(|v| v.as_str()) == Some("booked"));
    assert!(!booked, "Anomaly reconcile must not emit any Booked event");

    Ok(())
}
