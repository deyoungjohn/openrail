//! Tests for Phase 2 Card A10: Storage-Credit Sponsor Pool (REL-1).
//!
//! Blueprint references: REL-1, Card A10.
//!
//! Covers:
//! 1. Sponsor pool deposit by anyone and root-only withdraw.
//! 2. First N invoices sponsored then refused when cap is reached.
//! 3. Business's own storage credit used before drawing from the sponsor pool.
//! 4. Sponsor pool never underflows when balance is insufficient.
//! 5. Failed issuance (claim account creation failure) returns the sponsor draw.
//! 6. Cap is enforced per business and can be updated by root.
//! 7. Storage-credit conservation invariant (credits + pool + locked claim storage == net deposits).
//! 8. `next_token_id` view returns plain sequential u64 counter.

use anyhow::Result;
use near_sdk::json_types::U128;
use near_workspaces::types::NearToken;
use openrail::claims::REQUIRED_ISSUE_DEPOSIT;
use openrail::types::{ClaimView, Debtor, Hex32};
use openrail_tests::Env;
use serde::{Deserialize, Serialize};
use serde_json::json;

/// View structure returned by `sponsor_status(account_id)`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SponsorStatusView {
    pub pool: U128,
    pub cap: u64,
    pub used: u64,
}

/// Helper to query sponsor status for a given account.
async fn get_sponsor_status(
    env: &Env,
    account_id: &near_workspaces::AccountId,
) -> Result<SponsorStatusView> {
    let status: SponsorStatusView = env
        .root
        .view("sponsor_status")
        .args_json(json!({ "account_id": account_id }))
        .await?
        .json()?;
    Ok(status)
}

/// Helper to query personal storage credit for a given account.
async fn get_storage_credit(env: &Env, account_id: &near_workspaces::AccountId) -> Result<u128> {
    let credit: U128 = env
        .root
        .view("storage_credit_of")
        .args_json(json!({ "account_id": account_id }))
        .await?
        .json()?;
    Ok(credit.0)
}

/// Helper to issue a claim via `issue_for` from the designated issuer.
async fn issue_claim_for_business(
    env: &Env,
    business: &near_workspaces::AccountId,
    debtor: &near_workspaces::AccountId,
) -> Result<near_workspaces::result::ExecutionFinalResult> {
    let terms_hash = Hex32::new([42u8; 32]);
    let res = env
        .issuer
        .call(env.root.id(), "issue_for")
        .args_json(json!({
            "business": business,
            "kind": 0,
            "debtor": Debtor::Near(debtor.clone()),
            "terms_hash": terms_hash,
            "amount_due": U128(10_000_000),
            "due_date": 1_800_000_000u64,
            "metadata": null,
        }))
        .max_gas()
        .transact()
        .await?;
    Ok(res)
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Pool deposit and root-only withdraw
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_sponsor_pool_deposit_and_root_only_withdraw() -> Result<()> {
    let env = Env::new().await?;

    // Initial status: pool is empty, cap is default 5, used is 0
    let status_init = get_sponsor_status(&env, env.alice.id()).await?;
    assert_eq!(status_init.pool.0, 0, "Initial pool must be zero");
    assert_eq!(status_init.cap, 5, "Default cap must be 5");
    assert_eq!(status_init.used, 0, "Initial used must be zero");

    // 1. Anyone can deposit into the sponsor pool (Alice deposits 2 NEAR)
    let deposit_alice = NearToken::from_near(2);
    let res_dep_alice = env
        .alice
        .call(env.root.id(), "deposit_sponsor_pool")
        .deposit(deposit_alice)
        .max_gas()
        .transact()
        .await?;
    assert!(res_dep_alice.is_success(), "Alice deposit must succeed");

    let status_after_alice = get_sponsor_status(&env, env.alice.id()).await?;
    assert_eq!(
        status_after_alice.pool.0,
        deposit_alice.as_yoctonear(),
        "Pool must reflect Alice deposit"
    );

    // Bob deposits 1 NEAR
    let deposit_bob = NearToken::from_near(1);
    let res_dep_bob = env
        .bob
        .call(env.root.id(), "deposit_sponsor_pool")
        .deposit(deposit_bob)
        .max_gas()
        .transact()
        .await?;
    assert!(res_dep_bob.is_success(), "Bob deposit must succeed");

    let status_after_bob = get_sponsor_status(&env, env.bob.id()).await?;
    assert_eq!(
        status_after_bob.pool.0,
        NearToken::from_near(3).as_yoctonear(),
        "Pool must reflect total 3 NEAR deposits"
    );

    // 2. Non-root accounts cannot withdraw from the sponsor pool
    let withdraw_amount = NearToken::from_near(1);
    let res_withdraw_alice = env
        .alice
        .call(env.root.id(), "withdraw_sponsor_pool")
        .args_json(json!({ "amount": U128(withdraw_amount.as_yoctonear()) }))
        .max_gas()
        .transact()
        .await?;
    assert!(
        res_withdraw_alice.is_failure(),
        "Alice (non-root) withdraw must be rejected"
    );

    let res_withdraw_bob = env
        .bob
        .call(env.root.id(), "withdraw_sponsor_pool")
        .args_json(json!({ "amount": U128(withdraw_amount.as_yoctonear()) }))
        .max_gas()
        .transact()
        .await?;
    assert!(
        res_withdraw_bob.is_failure(),
        "Bob (non-root) withdraw must be rejected"
    );

    // Pool remains intact after rejected withdraw attempts
    let status_intact = get_sponsor_status(&env, env.alice.id()).await?;
    assert_eq!(
        status_intact.pool.0,
        NearToken::from_near(3).as_yoctonear(),
        "Pool balance must not change on rejected withdrawals"
    );

    // 3. Root account can withdraw from the sponsor pool
    let res_withdraw_root = env
        .root
        .call("withdraw_sponsor_pool")
        .args_json(json!({ "amount": U128(withdraw_amount.as_yoctonear()) }))
        .max_gas()
        .transact()
        .await?;
    assert!(res_withdraw_root.is_success(), "Root withdraw must succeed");

    let status_after_root = get_sponsor_status(&env, env.alice.id()).await?;
    assert_eq!(
        status_after_root.pool.0,
        NearToken::from_near(2).as_yoctonear(),
        "Pool balance must decrease to 2 NEAR after root withdrawal"
    );

    // 4. Root cannot withdraw more than current pool balance
    let excess_withdraw = NearToken::from_near(5);
    let res_excess = env
        .root
        .call("withdraw_sponsor_pool")
        .args_json(json!({ "amount": U128(excess_withdraw.as_yoctonear()) }))
        .max_gas()
        .transact()
        .await?;
    assert!(
        res_excess.is_failure(),
        "Root withdraw exceeding pool balance must be refused"
    );

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: First N invoices sponsored then refused
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_sponsor_first_n_invoices_sponsored_then_refused() -> Result<()> {
    let env = Env::new().await?;

    // Seed sponsor pool with 1 NEAR (plenty for 5 invoices at 20 mN each)
    let initial_pool = NearToken::from_near(1);
    env.root
        .call("deposit_sponsor_pool")
        .deposit(initial_pool)
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Bob has zero storage credit
    assert_eq!(get_storage_credit(&env, env.bob.id()).await?, 0);

    let deposit_per_claim = REQUIRED_ISSUE_DEPOSIT.as_yoctonear();

    // Issue first 5 invoices (default cap is 5)
    for i in 1..=5 {
        let res = issue_claim_for_business(&env, env.bob.id(), env.alice.id()).await?;
        assert!(res.is_success(), "Sponsored invoice #{} must succeed", i);

        // Check storage_sponsored event was emitted
        let events = openrail_tests::decode_events(&res);
        let has_sponsored_event = events
            .iter()
            .any(|e| e.get("event").and_then(|v| v.as_str()) == Some("storage_sponsored"));
        assert!(
            has_sponsored_event,
            "Invoice #{} must emit storage_sponsored event",
            i
        );

        // Bob's personal credit remains 0
        assert_eq!(
            get_storage_credit(&env, env.bob.id()).await?,
            0,
            "Bob's personal credit must remain 0"
        );

        // Sponsor status checks
        let status = get_sponsor_status(&env, env.bob.id()).await?;
        assert_eq!(status.used, i as u64, "Used count must equal {}", i);
        assert_eq!(status.cap, 5, "Cap must remain 5");
        let expected_pool = initial_pool.as_yoctonear() - (i as u128 * deposit_per_claim);
        assert_eq!(
            status.pool.0, expected_pool,
            "Pool balance must decrease by 20 mN per invoice"
        );
    }

    // 6th invoice must be refused with NO_STORAGE_CREDIT
    let res_6 = issue_claim_for_business(&env, env.bob.id(), env.alice.id()).await?;
    assert!(
        res_6.is_failure(),
        "6th invoice exceeding cap must be refused"
    );

    // Verify panic message indicates missing storage credit
    let failure_logs = format!("{:?}", res_6);
    assert!(
        failure_logs.contains("NO_STORAGE_CREDIT"),
        "Failure must indicate NO_STORAGE_CREDIT"
    );

    // Used count remains capped at 5
    let status_after_refusal = get_sponsor_status(&env, env.bob.id()).await?;
    assert_eq!(status_after_refusal.used, 5, "Used count must remain 5");

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Own credit used before the pool
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_sponsor_own_credit_used_before_pool() -> Result<()> {
    let env = Env::new().await?;

    // Seed sponsor pool with 1 NEAR
    let pool_amount = NearToken::from_near(1);
    env.root
        .call("deposit_sponsor_pool")
        .deposit(pool_amount)
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Bob deposits personal storage credit for exactly 1 claim (20 mN)
    let bob_credit = REQUIRED_ISSUE_DEPOSIT;
    env.bob
        .call(env.root.id(), "deposit_storage_credit")
        .deposit(bob_credit)
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    assert_eq!(
        get_storage_credit(&env, env.bob.id()).await?,
        bob_credit.as_yoctonear()
    );

    // Issue claim for Bob: must use Bob's own storage credit, NOT the pool
    let res_1 = issue_claim_for_business(&env, env.bob.id(), env.alice.id()).await?;
    assert!(res_1.is_success(), "First invoice for Bob must succeed");

    // Verify Bob's personal credit was consumed
    assert_eq!(
        get_storage_credit(&env, env.bob.id()).await?,
        0,
        "Bob's personal storage credit must be consumed"
    );

    // Sponsor pool and Bob's sponsored count must be completely untouched
    let status_1 = get_sponsor_status(&env, env.bob.id()).await?;
    assert_eq!(
        status_1.pool.0,
        pool_amount.as_yoctonear(),
        "Pool balance must remain untouched when business has personal credit"
    );
    assert_eq!(
        status_1.used, 0,
        "Sponsored count must remain 0 when personal credit was used"
    );

    // Verify storage_sponsored event was NOT emitted
    let events_1 = openrail_tests::decode_events(&res_1);
    let has_sponsored_event = events_1
        .iter()
        .any(|e| e.get("event").and_then(|v| v.as_str()) == Some("storage_sponsored"));
    assert!(
        !has_sponsored_event,
        "Must NOT emit storage_sponsored event when personal credit was used"
    );

    // Now Bob has 0 personal credit; next invoice must draw from the sponsor pool
    let res_2 = issue_claim_for_business(&env, env.bob.id(), env.alice.id()).await?;
    assert!(
        res_2.is_success(),
        "Second invoice for Bob must succeed via pool"
    );

    let status_2 = get_sponsor_status(&env, env.bob.id()).await?;
    assert_eq!(status_2.used, 1, "Sponsored count must now increment to 1");
    assert_eq!(
        status_2.pool.0,
        pool_amount.as_yoctonear() - REQUIRED_ISSUE_DEPOSIT.as_yoctonear(),
        "Pool must now be deducted by 20 mN"
    );

    let events_2 = openrail_tests::decode_events(&res_2);
    let has_sponsored_event_2 = events_2
        .iter()
        .any(|e| e.get("event").and_then(|v| v.as_str()) == Some("storage_sponsored"));
    assert!(
        has_sponsored_event_2,
        "Must emit storage_sponsored event when pool was used"
    );

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Pool never underflows
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_sponsor_pool_never_underflows() -> Result<()> {
    let env = Env::new().await?;

    // Case A: Pool is completely empty (0 NEAR)
    let status_zero = get_sponsor_status(&env, env.carol.id()).await?;
    assert_eq!(status_zero.pool.0, 0);

    let res_zero = issue_claim_for_business(&env, env.carol.id(), env.alice.id()).await?;
    assert!(
        res_zero.is_failure(),
        "Issuance with 0 pool balance must fail"
    );
    let status_after_zero = get_sponsor_status(&env, env.carol.id()).await?;
    assert_eq!(status_after_zero.pool.0, 0, "Pool balance must remain 0");
    assert_eq!(status_after_zero.used, 0, "Used count must remain 0");

    // Case B: Pool has non-zero but insufficient balance (10 mN when 20 mN is required)
    let insufficient_deposit = NearToken::from_millinear(10);
    env.root
        .call("deposit_sponsor_pool")
        .deposit(insufficient_deposit)
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let status_partial = get_sponsor_status(&env, env.carol.id()).await?;
    assert_eq!(status_partial.pool.0, insufficient_deposit.as_yoctonear());

    let res_partial = issue_claim_for_business(&env, env.carol.id(), env.alice.id()).await?;
    assert!(
        res_partial.is_failure(),
        "Issuance with insufficient pool balance must fail with NO_STORAGE_CREDIT"
    );

    // Verify pool balance did NOT underflow and remains exactly 10 mN
    let status_after_partial = get_sponsor_status(&env, env.carol.id()).await?;
    assert_eq!(
        status_after_partial.pool.0,
        insufficient_deposit.as_yoctonear(),
        "Pool must never underflow below available balance"
    );
    assert_eq!(
        status_after_partial.used, 0,
        "Used count must not increment on failed draw"
    );

    // Deposit remaining 10 mN so pool reaches exactly 20 mN (1 claim)
    env.root
        .call("deposit_sponsor_pool")
        .deposit(NearToken::from_millinear(10))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Now issuance succeeds and consumes the full 20 mN
    let res_ok = issue_claim_for_business(&env, env.carol.id(), env.alice.id()).await?;
    assert!(
        res_ok.is_success(),
        "Issuance with exact balance must succeed"
    );

    let status_empty = get_sponsor_status(&env, env.carol.id()).await?;
    assert_eq!(status_empty.pool.0, 0, "Pool balance must reach exactly 0");
    assert_eq!(status_empty.used, 1, "Used count must be 1");

    // Next issuance when pool reached 0 must fail without underflowing
    let res_next = issue_claim_for_business(&env, env.carol.id(), env.alice.id()).await?;
    assert!(res_next.is_failure(), "Issuance when drained must fail");

    let status_final = get_sponsor_status(&env, env.carol.id()).await?;
    assert_eq!(status_final.pool.0, 0, "Pool balance must remain 0");

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Failed issuance returns the draw
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_sponsor_failed_issuance_returns_draw() -> Result<()> {
    let env = Env::new().await?;

    // Seed sponsor pool with 1 NEAR
    let pool_init = NearToken::from_near(1);
    env.root
        .call("deposit_sponsor_pool")
        .deposit(pool_init)
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Simulate account creation failure by setting vault_code_hash to an invalid hash
    // (Existing refund path in `issue.rs:internal_on_issue` deletes claim and refunds storage cost)
    let invalid_hash = Hex32::new([99u8; 32]);
    let cfg_res = env
        .root
        .call("set_config")
        .args_json(json!({ "vault_code_hash": invalid_hash }))
        .max_gas()
        .transact()
        .await?;
    assert!(cfg_res.is_success(), "set_config must succeed");

    let status_before = get_sponsor_status(&env, env.bob.id()).await?;
    assert_eq!(status_before.pool.0, pool_init.as_yoctonear());
    assert_eq!(status_before.used, 0);

    // Call issue_for for Bob (0 personal credit)
    let res = issue_claim_for_business(&env, env.bob.id(), env.alice.id()).await?;
    assert!(
        res.is_success(),
        "Transaction finishes callback handling cleanly"
    );

    // Claim c-1 must NOT exist in state because account creation failed
    let claim_view: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert!(
        claim_view.is_none(),
        "Claim c-1 must be deleted from state on failure"
    );

    // The draw must be returned: pool balance restored to 1 NEAR and used count reverted to 0
    let status_after = get_sponsor_status(&env, env.bob.id()).await?;
    assert_eq!(
        status_after.pool.0,
        pool_init.as_yoctonear(),
        "Sponsor pool must have the drawn deposit returned on failed issuance"
    );
    assert_eq!(
        status_after.used, 0,
        "Sponsored count must be reverted to 0 when issuance fails"
    );

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: The cap is per business
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_sponsor_cap_is_per_business() -> Result<()> {
    let env = Env::new().await?;

    // Seed sponsor pool with 1 NEAR
    env.root
        .call("deposit_sponsor_pool")
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Business Bob uses all 5 sponsored slots
    for _ in 0..5 {
        let res = issue_claim_for_business(&env, env.bob.id(), env.alice.id()).await?;
        assert!(res.is_success());
    }

    // Bob is now at cap
    let status_bob = get_sponsor_status(&env, env.bob.id()).await?;
    assert_eq!(status_bob.used, 5);

    let res_bob_6 = issue_claim_for_business(&env, env.bob.id(), env.alice.id()).await?;
    assert!(res_bob_6.is_failure(), "Bob must be refused at cap");

    // Business Carol has not used any sponsored slots; her cap must be independent
    let status_carol_init = get_sponsor_status(&env, env.carol.id()).await?;
    assert_eq!(status_carol_init.used, 0, "Carol starts with 0 used");
    assert_eq!(status_carol_init.cap, 5, "Carol has full cap of 5");

    let res_carol_1 = issue_claim_for_business(&env, env.carol.id(), env.alice.id()).await?;
    assert!(
        res_carol_1.is_success(),
        "Carol must succeed despite Bob being at cap"
    );

    let status_carol_after = get_sponsor_status(&env, env.carol.id()).await?;
    assert_eq!(status_carol_after.used, 1, "Carol used count is 1");
    assert_eq!(
        get_sponsor_status(&env, env.bob.id()).await?.used,
        5,
        "Bob used count remains 5"
    );

    // Root can update the sponsor cap (e.g. raise to 6)
    let res_cap = env
        .root
        .call("set_sponsor_cap")
        .args_json(json!({ "cap": 6u64 }))
        .max_gas()
        .transact()
        .await?;
    assert!(res_cap.is_success(), "Root set_sponsor_cap must succeed");

    assert_eq!(get_sponsor_status(&env, env.bob.id()).await?.cap, 6);
    assert_eq!(get_sponsor_status(&env, env.carol.id()).await?.cap, 6);

    // Now Bob can issue a 6th sponsored invoice under the new cap
    let res_bob_new_cap = issue_claim_for_business(&env, env.bob.id(), env.alice.id()).await?;
    assert!(
        res_bob_new_cap.is_success(),
        "Bob must be able to issue under raised cap"
    );
    assert_eq!(get_sponsor_status(&env, env.bob.id()).await?.used, 6);

    // 7th invoice for Bob is refused
    let res_bob_7 = issue_claim_for_business(&env, env.bob.id(), env.alice.id()).await?;
    assert!(res_bob_7.is_failure(), "Bob refused at new cap of 6");

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Storage-credit conservation invariant
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_sponsor_storage_credit_conservation_invariant() -> Result<()> {
    let env = Env::new().await?;

    let deposit_per_claim = REQUIRED_ISSUE_DEPOSIT.as_yoctonear();
    let mut total_deposited: u128 = 0;
    let mut total_withdrawn: u128 = 0;
    let mut active_claims_count: u64 = 0;

    // Helper closure to assert conservation invariant
    let assert_conservation = |credits: u128, pool: u128, claims: u64, dep: u128, with: u128| {
        let net_deposited = dep.saturating_sub(with);
        let locked_storage = (claims as u128) * deposit_per_claim;
        let total_accounted = credits + pool + locked_storage;
        assert_eq!(
            total_accounted, net_deposited,
            "Conservation invariant violated: credits ({}) + pool ({}) + locked ({}) != net deposited ({})",
            credits, pool, locked_storage, net_deposited
        );
    };

    // Step 0: Initial state
    assert_conservation(0, 0, 0, total_deposited, total_withdrawn);

    // Step 1: Alice deposits 100 mN storage credit
    let alice_deposit = NearToken::from_millinear(100);
    env.alice
        .call(env.root.id(), "deposit_storage_credit")
        .deposit(alice_deposit)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    total_deposited += alice_deposit.as_yoctonear();

    let pool = get_sponsor_status(&env, env.alice.id()).await?.pool.0;
    let credits = get_storage_credit(&env, env.alice.id()).await?;
    assert_conservation(
        credits,
        pool,
        active_claims_count,
        total_deposited,
        total_withdrawn,
    );

    // Step 2: Anyone deposits 200 mN into sponsor pool
    let pool_deposit = NearToken::from_millinear(200);
    env.root
        .call("deposit_sponsor_pool")
        .deposit(pool_deposit)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    total_deposited += pool_deposit.as_yoctonear();

    let pool = get_sponsor_status(&env, env.alice.id()).await?.pool.0;
    let credits = get_storage_credit(&env, env.alice.id()).await?;
    assert_conservation(
        credits,
        pool,
        active_claims_count,
        total_deposited,
        total_withdrawn,
    );

    // Step 3: Bob issues 2 claims sponsored by the pool
    for _ in 0..2 {
        let res = issue_claim_for_business(&env, env.bob.id(), env.alice.id()).await?;
        assert!(res.is_success());
        active_claims_count += 1;
    }

    let pool = get_sponsor_status(&env, env.alice.id()).await?.pool.0;
    let credits = get_storage_credit(&env, env.alice.id()).await?
        + get_storage_credit(&env, env.bob.id()).await?;
    assert_conservation(
        credits,
        pool,
        active_claims_count,
        total_deposited,
        total_withdrawn,
    );

    // Step 4: Alice issues 1 claim using her own credit
    let res_alice = issue_claim_for_business(&env, env.alice.id(), env.bob.id()).await?;
    assert!(res_alice.is_success());
    active_claims_count += 1;

    let pool = get_sponsor_status(&env, env.alice.id()).await?.pool.0;
    let credits = get_storage_credit(&env, env.alice.id()).await?
        + get_storage_credit(&env, env.bob.id()).await?;
    assert_conservation(
        credits,
        pool,
        active_claims_count,
        total_deposited,
        total_withdrawn,
    );

    // Step 5: Alice withdraws 40 mN from her personal storage credit
    let alice_withdraw = NearToken::from_millinear(40);
    env.alice
        .call(env.root.id(), "withdraw_storage_credit")
        .args_json(json!({ "amount": U128(alice_withdraw.as_yoctonear()) }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    total_withdrawn += alice_withdraw.as_yoctonear();

    let pool = get_sponsor_status(&env, env.alice.id()).await?.pool.0;
    let credits = get_storage_credit(&env, env.alice.id()).await?
        + get_storage_credit(&env, env.bob.id()).await?;
    assert_conservation(
        credits,
        pool,
        active_claims_count,
        total_deposited,
        total_withdrawn,
    );

    // Step 6: Root withdraws 60 mN from the sponsor pool
    let pool_withdraw = NearToken::from_millinear(60);
    env.root
        .call("withdraw_sponsor_pool")
        .args_json(json!({ "amount": U128(pool_withdraw.as_yoctonear()) }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    total_withdrawn += pool_withdraw.as_yoctonear();

    let pool = get_sponsor_status(&env, env.alice.id()).await?.pool.0;
    let credits = get_storage_credit(&env, env.alice.id()).await?
        + get_storage_credit(&env, env.bob.id()).await?;
    assert_conservation(
        credits,
        pool,
        active_claims_count,
        total_deposited,
        total_withdrawn,
    );

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: next_token_id view
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_sponsor_next_token_id_view() -> Result<()> {
    let env = Env::new().await?;

    // Initial state: next_token_id must return 1 as a plain number
    let next_id: u64 = env.root.view("next_token_id").await?.json()?;
    assert_eq!(next_id, 1, "Initial next_token_id must be 1");

    // Deposit credit and issue one claim for Alice
    env.alice
        .call(env.root.id(), "deposit_storage_credit")
        .deposit(REQUIRED_ISSUE_DEPOSIT)
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let res = issue_claim_for_business(&env, env.alice.id(), env.bob.id()).await?;
    assert!(res.is_success());

    // After issuing c-1, next_token_id must now be 2
    let next_id_after: u64 = env.root.view("next_token_id").await?.json()?;
    assert_eq!(next_id_after, 2, "next_token_id must increment to 2");

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: Measure gas for issue_for with and without sponsor pool
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_sponsor_issue_for_gas_comparison() -> Result<()> {
    let env = Env::new().await?;

    // 1. Measure issue_for WITHOUT sponsor pool (using personal storage credit)
    env.alice
        .call(env.root.id(), "deposit_storage_credit")
        .deposit(REQUIRED_ISSUE_DEPOSIT)
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let res_own = issue_claim_for_business(&env, env.alice.id(), env.bob.id()).await?;
    assert!(res_own.is_success());
    let gas_own = openrail_tests::GasReport::from_result(&res_own);

    // 2. Measure issue_for WITH sponsor pool (sponsored)
    env.root
        .call("deposit_sponsor_pool")
        .deposit(REQUIRED_ISSUE_DEPOSIT)
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let res_sponsored = issue_claim_for_business(&env, env.bob.id(), env.carol.id()).await?;
    assert!(res_sponsored.is_success());
    let gas_sponsored = openrail_tests::GasReport::from_result(&res_sponsored);

    println!(
        "GAS BENCHMARK: issue_for without pool: {:.3} Tgas ({} gas)",
        gas_own.total_tgas,
        gas_own.total_gas.as_gas()
    );
    println!(
        "GAS BENCHMARK: issue_for with pool:    {:.3} Tgas ({} gas)",
        gas_sponsored.total_tgas,
        gas_sponsored.total_gas.as_gas()
    );

    assert!(gas_own.total_tgas < 30.0);
    assert!(gas_sponsored.total_tgas < 30.0);

    Ok(())
}
