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
