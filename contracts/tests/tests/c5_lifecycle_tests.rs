//! Acceptance and lifecycle tests for C5 (Blueprint 2.2, 2.3, 2.5).
//!
//! Covers:
//! - `close`: closes fully paid claims (`Paid` -> `Closed`), enforces surplus == 0 and owner-only
//! - `close_writeoff`: closes partially paid claims (`PartiallyPaid` -> `Closed`), records shortfall
//! - `release_surplus`: releases accumulated surplus to owner, forwards funds from vault, resets surplus
//! - `apply_credit`: applies value-less credit within outstanding limit, write-once credit source

use anyhow::Result;
use openrail::types::{ClaimView, Debtor, Hex32, Status};
use openrail_tests::Env;
use serde_json::json;

#[tokio::test]
async fn test_c5_close_enforces_rules_and_emits_event() -> Result<()> {
    let env = Env::new().await?;

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
    let token_id: String = issue_res.json()?;

    // 1. Cannot close when status is Issued
    let close_unpaid = env
        .alice
        .call(env.root.id(), "close")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(close_unpaid.is_failure());
    assert!(format!("{:?}", close_unpaid.failures()).contains("claim is not Paid"));

    // 2. Fund partially (500_000) and reconcile -> status is PartiallyPaid
    let _ = env.fund_claim(&token_id, 500_000, None).await?;
    let rec1 = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec1.is_success());

    // Cannot close when status is PartiallyPaid
    let close_partially_paid = env
        .alice
        .call(env.root.id(), "close")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(close_partially_paid.is_failure());
    assert!(format!("{:?}", close_partially_paid.failures()).contains("claim is not Paid"));

    // 3. Fund remaining 500_000 + 200_000 extra surplus
    let _ = env.fund_claim(&token_id, 700_000, None).await?;
    let rec2 = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec2.is_success());

    let view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(view.status, Status::Paid);
    assert_eq!(view.surplus.0, 200_000);

    // 4. Cannot close while surplus > 0
    let close_with_surplus = env
        .alice
        .call(env.root.id(), "close")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(close_with_surplus.is_failure());
    assert!(format!("{:?}", close_with_surplus.failures()).contains("claim has unreleased surplus"));

    // 5. Non-owner (Bob) cannot call close
    let close_non_owner = env
        .bob
        .call(env.root.id(), "close")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(close_non_owner.is_failure());
    assert!(format!("{:?}", close_non_owner.failures()).contains("owner only"));

    // 6. Release surplus
    let rel = env
        .alice
        .call(env.root.id(), "release_surplus")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rel.is_success());

    let view2: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(view2.surplus.0, 0);

    // 7. Now Alice closes the claim
    let close_success = env
        .alice
        .call(env.root.id(), "close")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(close_success.is_success());

    let close_events = env.assert_event(&close_success, "close");
    assert!(!close_events.is_empty(), "close event must be emitted");

    let final_view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(final_view.status, Status::Closed);

    Ok(())
}

#[tokio::test]
async fn test_c5_close_writeoff_enforces_rules_and_emits_event() -> Result<()> {
    let env = Env::new().await?;

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
    let token_id: String = issue_res.json()?;

    // 1. Cannot writeoff when status is Issued
    let writeoff_issued = env
        .alice
        .call(env.root.id(), "close_writeoff")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(writeoff_issued.is_failure());
    assert!(format!("{:?}", writeoff_issued.failures()).contains("claim is not PartiallyPaid"));

    // 2. Fund partially (400_000) and reconcile -> status is PartiallyPaid
    let _ = env.fund_claim(&token_id, 400_000, None).await?;
    let rec1 = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec1.is_success());

    // 3. Non-owner (Bob) cannot call close_writeoff
    let non_owner_writeoff = env
        .bob
        .call(env.root.id(), "close_writeoff")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(non_owner_writeoff.is_failure());
    assert!(format!("{:?}", non_owner_writeoff.failures()).contains("owner only"));

    // 4. Alice closes claim with writeoff recording shortfall of 600_000
    let writeoff_success = env
        .alice
        .call(env.root.id(), "close_writeoff")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(writeoff_success.is_success());

    let writeoff_events = env.assert_event(&writeoff_success, "writeoff");
    assert!(
        !writeoff_events.is_empty(),
        "writeoff event must be emitted"
    );
    assert_eq!(
        writeoff_events[0]["data"][0]["shortfall"], "600000",
        "shortfall must equal remaining outstanding"
    );

    let view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(view.status, Status::Closed);

    Ok(())
}

#[tokio::test]
async fn test_c5_release_surplus_enforces_rules_and_emits_event() -> Result<()> {
    let env = Env::new().await?;

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
    let token_id: String = issue_res.json()?;

    // 1. Cannot release surplus when surplus == 0
    let rel_zero = env
        .alice
        .call(env.root.id(), "release_surplus")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rel_zero.is_failure());
    assert!(format!("{:?}", rel_zero.failures()).contains("no surplus to release"));

    // 2. Fund 1_500_000 (1_000_000 payment + 500_000 surplus)
    let _ = env.fund_claim(&token_id, 1_500_000, None).await?;
    let rec = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec.is_success());

    let view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(view.surplus.0, 500_000);

    // 3. Non-owner cannot release surplus
    let rel_bob = env
        .bob
        .call(env.root.id(), "release_surplus")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rel_bob.is_failure());
    assert!(format!("{:?}", rel_bob.failures()).contains("owner only"));

    // 4. Alice releases surplus
    let rel_success = env
        .alice
        .call(env.root.id(), "release_surplus")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rel_success.is_success());

    let surplus_events = env.assert_event(&rel_success, "surplus_released");
    assert!(
        !surplus_events.is_empty(),
        "surplus_released event must be emitted"
    );
    assert_eq!(surplus_events[0]["data"][0]["amount"], "500000");
    assert_eq!(
        surplus_events[0]["data"][0]["receiver_id"],
        env.alice.id().as_str()
    );

    let dist_events = env.assert_event(&rel_success, "distributed");
    assert!(
        !dist_events.is_empty(),
        "distributed event must also be emitted on successful surplus release"
    );

    let post_view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(post_view.surplus.0, 0);

    Ok(())
}

#[tokio::test]
async fn test_c5_release_surplus_nonexistent_receiver_fails_to_undistributed() -> Result<()> {
    let env = Env::new().await?;

    // Create an owner whose ID contains "nonexistent", so forwards will fail in mock intents
    let nonexistent_owner = env
        .worker
        .root_account()?
        .create_subaccount("nonexistent-owner")
        .initial_balance(near_workspaces::types::NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;

    let issue_res = env
        .issue_claim_with_details(
            &nonexistent_owner,
            0,
            Some(Debtor::Near(env.bob.id().clone())),
            Hex32::default(),
            1_000_000,
            1_800_000_000,
            None,
        )
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    // Fund with 1_500_000 (1_000_000 payment + 500_000 surplus)
    let _ = env.fund_claim(&token_id, 1_500_000, None).await?;

    // Reconcile
    let rec = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec.is_success());

    let view_before: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(view_before.status, Status::Paid);
    assert_eq!(view_before.surplus.0, 500_000);
    assert_eq!(
        view_before.undistributed.len(),
        1,
        "Reconcile payment leg to nonexistent owner was queued into undistributed"
    );

    // Call release_surplus as nonexistent_owner
    let rel_res = nonexistent_owner
        .call(env.root.id(), "release_surplus")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rel_res.is_success());

    // surplus_released must NOT be emitted
    let decoded = openrail_tests::decode_events(&rel_res);
    assert!(
        !decoded
            .iter()
            .any(|e| e.get("event").and_then(|v| v.as_str()) == Some("surplus_released")),
        "surplus_released must NOT be emitted for failed forward"
    );

    // distribution_failed MUST be emitted
    let failed_events = env.assert_event(&rel_res, "distribution_failed");
    assert_eq!(
        failed_events.len(),
        1,
        "distribution_failed must be emitted for failed surplus forward"
    );

    // Check post claim state
    let post_view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;

    assert_eq!(
        post_view.surplus.0, 0,
        "surplus zeroed upon distribution dispatch"
    );
    assert_eq!(
        post_view.undistributed.len(),
        2,
        "Failed surplus leg queued into undistributed alongside reconcile leg"
    );
    assert_eq!(
        post_view.lock,
        openrail::types::Lock::None,
        "Lock restored to None"
    );

    Ok(())
}

#[tokio::test]
async fn test_c5_reconcile_gas_check() -> Result<()> {
    let env = Env::new().await?;

    let issue_res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    // 1. Reconcile with 100 Tgas fails with "insufficient gas for reconcile"
    let rec_low_gas = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(rec_low_gas.is_failure());
    let failure = format!("{:?}", rec_low_gas.failures());
    assert!(
        failure.contains("insufficient gas for reconcile"),
        "Must fail with 'insufficient gas for reconcile', got: {failure}"
    );

    // 2. Reconcile with 250 Tgas succeeds
    let rec_ok_gas = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .gas(near_workspaces::types::Gas::from_tgas(250))
        .transact()
        .await?;
    assert!(rec_ok_gas.is_success());

    Ok(())
}

#[tokio::test]
async fn test_c5_retry_distribution_rejected_during_reconcile() -> Result<()> {
    let env = Env::new().await?;

    let amount_due = 1_000_000u128;
    let _ = env
        .issue_claim(&env.alice, 0, amount_due, 1_800_000_000)
        .await?;

    // Set fee account to an account that rejects transfer in mock intents to create an undistributed leg
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

    let _ = env.fund_claim("c-1", amount_due, None).await?;

    let rec_res = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec_res.is_success());

    let cv: openrail::types::ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert!(!cv.undistributed.is_empty(), "Must have undistributed leg");

    // Patch state of claim c-1 to have Lock::Reconciling
    let records = env.root.view_state().await?;
    let mut patched = false;
    for (k, v) in records {
        if let Ok(mut claim) =
            <openrail::types::Claim as near_sdk::borsh::BorshDeserialize>::try_from_slice(&v)
        {
            if claim.token_id == "c-1" {
                claim.lock = openrail::types::Lock::Reconciling { since: 50 };
                let updated = near_sdk::borsh::to_vec(&claim).unwrap();
                env.worker.patch_state(env.root.id(), &k, &updated).await?;
                patched = true;
                break;
            }
        }
    }
    assert!(patched, "Claim state record must be found and patched");

    // Verify claim lock is now Reconciling
    let view_locked: openrail::types::ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert!(matches!(
        view_locked.lock,
        openrail::types::Lock::Reconciling { .. }
    ));

    // Calling retry_distribution must fail because claim is Reconciling
    let retry_res = env
        .alice
        .call(env.root.id(), "retry_distribution")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(retry_res.is_failure());
    let failure = format!("{:?}", retry_res.failures());
    assert!(
        failure.contains("cannot retry while reconciling"),
        "Must fail with 'cannot retry while reconciling', got: {failure}"
    );

    Ok(())
}

/// C5 fix 1 (D-S8, conservation): A forward that fails while the claim lock was cleared by
/// `clear_stale_lock` (mocking the stale `on_distributed` callback) must end with the leg in
/// `undistributed` and `last_seen_balance` unchanged, and a following `reconcile` must book nothing.
#[tokio::test]
#[ignore = "C5fix"]
async fn test_c5_stale_callback_failed_forward_preserves_undistributed_and_last_seen() -> Result<()>
{
    let env = Env::new().await?;
    let asset = openrail_tests::DEFAULT_SETTLEMENT_ASSET.to_string();

    // 1. Issue a 1_000_000 USDC claim and fund 1_500_000 USDC (1_000_000 payment + 500_000 surplus)
    let issue_res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    let _ = env.fund_claim(&token_id, 1_500_000, None).await?;
    let rec = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec.is_success());

    // Record pre-forward last_seen_balance (500_000 USDC remaining in the claim vault)
    let mut claim_key = Vec::new();
    let mut last_seen_before = 0u128;
    for (k, v) in env.root.view_state().await? {
        if let Ok(claim) =
            <openrail::types::Claim as near_sdk::borsh::BorshDeserialize>::try_from_slice(&v)
        {
            if claim.token_id == token_id {
                claim_key = k;
                last_seen_before = claim
                    .last_seen_balance
                    .get(&asset)
                    .copied()
                    .unwrap_or(near_sdk::json_types::U128(0))
                    .0;
                break;
            }
        }
    }
    assert!(!claim_key.is_empty(), "Claim state record must exist");
    assert_eq!(last_seen_before, 500_000);

    // 2. Simulate in-flight forward dispatch (surplus zeroed, last_seen decremented by in-flight leg,
    //    lock set to Reconciling { since: 1 })
    for (k, v) in env.root.view_state().await? {
        if k == claim_key {
            let mut claim =
                <openrail::types::Claim as near_sdk::borsh::BorshDeserialize>::try_from_slice(&v)?;
            claim.surplus = near_sdk::json_types::U128(0);
            claim
                .last_seen_balance
                .insert(asset.clone(), near_sdk::json_types::U128(0));
            claim.lock = openrail::types::Lock::Reconciling { since: 1 };
            let updated = near_sdk::borsh::to_vec(&claim)?;
            env.worker.patch_state(env.root.id(), &k, &updated).await?;
            break;
        }
    }

    // 3. Advance > 100 blocks and clear the stale lock via clear_stale_lock
    env.worker.fast_forward(105).await?;
    let clear_res = env
        .alice
        .call(env.root.id(), "clear_stale_lock")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(clear_res.is_success());
    let view_cleared: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(view_cleared.lock, openrail::types::Lock::None);

    // 4. Mock the stale on_distributed callback arriving after clear_stale_lock with a failed forward
    //    (direct call has 0 promise results, so succeeded == false for the leg)
    let failed_leg = openrail::types::Leg::Pay {
        receiver: env.alice.id().clone(),
        amount: near_sdk::json_types::U128(500_000),
        asset: Some(asset.clone()),
    };
    let stale_cb = env
        .root
        .call("on_distributed")
        .args_json(json!({
            "token_id": token_id,
            "legs": [failed_leg],
            "prev_lock": openrail::types::Lock::None,
            "since": 1u64,
            "is_retry": false,
            "open_transfer_window": false,
            "is_surplus": true,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(stale_cb.is_success());

    // 5. Verify the failed leg is in undistributed and last_seen_balance is unchanged (500_000)
    let view_after_cb: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(
        view_after_cb.undistributed.len(),
        1,
        "Failed forward under cleared stale lock must record the leg in undistributed"
    );
    assert_eq!(view_after_cb.undistributed[0], failed_leg);

    let mut last_seen_after = 0u128;
    for (k, v) in env.root.view_state().await? {
        if k == claim_key {
            let claim =
                <openrail::types::Claim as near_sdk::borsh::BorshDeserialize>::try_from_slice(&v)?;
            last_seen_after = claim
                .last_seen_balance
                .get(&asset)
                .copied()
                .unwrap_or(near_sdk::json_types::U128(0))
                .0;
            break;
        }
    }
    assert_eq!(
        last_seen_after, last_seen_before,
        "last_seen_balance must be unchanged after failed forward callback"
    );

    // 6. A following reconcile must book nothing (delta == 0, no booked event, counters unchanged)
    let rec_follow = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec_follow.is_success());
    assert!(
        !rec_follow.logs().iter().any(|l| l.contains("EVENT_JSON")),
        "Following reconcile must book nothing and emit no EVENT_JSON, got: {:?}",
        rec_follow.logs()
    );

    let view_after_rec: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(view_after_rec.booked_total.0, 1_500_000);
    assert_eq!(view_after_rec.surplus.0, 0);
    assert_eq!(view_after_rec.undistributed.len(), 1);

    Ok(())
}

/// C5 fix 2 (D-S8): `close` on a `Paid` claim with a non-empty `undistributed` must be refused
/// with a static message, and succeed after `retry_distribution` clears it.
#[tokio::test]
#[ignore = "C5fix"]
async fn test_c5_close_refuses_non_empty_undistributed_until_retried() -> Result<()> {
    let env = Env::new().await?;

    // 1. Issue claim for 1_000_000 USDC
    let issue_res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    // 2. Patch claim vault so forward legs fail during reconcile, leaving claim Paid with undistributed legs
    let claim_account: near_workspaces::AccountId =
        format!("{token_id}.{}", env.root.id()).parse()?;
    env.worker
        .patch(&claim_account)
        .code(&openrail_tests::wasms::mock_usdc_wasm()?)
        .transact()
        .await?;

    let _ = env.fund_claim(&token_id, 1_000_000, None).await?;
    let rec = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec.is_success());

    let view_paid: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(view_paid.status, Status::Paid);
    assert_eq!(view_paid.surplus.0, 0);
    assert!(
        !view_paid.undistributed.is_empty(),
        "Paid claim must have non-empty undistributed legs after failed forward"
    );

    // 3. Calling close while undistributed is non-empty must be refused with a static message
    let close_refused = env
        .alice
        .call(env.root.id(), "close")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(
        close_refused.is_failure(),
        "close on a Paid claim with non-empty undistributed must be refused"
    );
    let failure = format!("{:?}", close_refused.failures());
    assert!(
        failure.contains("undistributed"),
        "Expected static refusal message mentioning undistributed, got: {failure}"
    );

    // 4. Restore vault code and run retry_distribution to clear undistributed
    env.worker
        .patch(&claim_account)
        .code(&openrail_tests::wasms::vault_wasm()?)
        .transact()
        .await?;

    let retry_res = env
        .alice
        .call(env.root.id(), "retry_distribution")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(retry_res.is_success());

    let view_cleared: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert!(
        view_cleared.undistributed.is_empty(),
        "undistributed must be empty after retry_distribution"
    );

    // 5. Calling close now succeeds and transitions status to Closed
    let close_ok = env
        .alice
        .call(env.root.id(), "close")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(
        close_ok.is_success(),
        "close must succeed after retry_distribution clears undistributed"
    );
    let close_events = env.assert_event(&close_ok, "close");
    assert!(!close_events.is_empty(), "close event must be emitted");

    let final_view: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert_eq!(final_view.status, Status::Closed);

    Ok(())
}
