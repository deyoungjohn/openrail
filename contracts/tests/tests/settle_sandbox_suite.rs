//! Independent Sandbox Integration Tests for Settle Module (A6) and Payout Support (A7).
//!
//! Blueprint references:
//! - blueprint/modules/settle.md
//! - blueprint/modules/_payout.md
//! - staging/payout-settle/README.md
//!
//! Covers:
//! 1. Real vault v2 forward on a claim account through payout support component.
//! 2. Measurement of payout gas consumption and safe MAX_PAYOUTS_PER_CALL.
//! 3. Multi-asset reconcile regression with Hold leg across two assets (capacity allocation).
//! 4. Review point 1: release_surplus draining held assets from claim account.
//! 5. Review point 2: lock expiry before report_payout and refund race with reconcile.

use anyhow::{Context, Result};
use near_sdk::json_types::U128;
use near_workspaces::types::NearToken;
use near_workspaces::AccountId;
use openrail::types::{ClaimView, Lock, Status};
use openrail_tests::{Env, DEFAULT_SETTLEMENT_ASSET};
use serde::{Deserialize, Serialize};
use serde_json::json;

const BASE_ASSET: &str = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const ZERO_NEAR: NearToken = NearToken::from_yoctonear(0);

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct DestinationView {
    pub chain: String,
    pub address: String,
    pub min_amount: U128,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum HeldStatusView {
    Held,
    InFlight { payout_id: u64 },
    Settled { payout_id: u64, destination_tx: String },
    Flagged { reason: String },
    Released { payout_id: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct HeldEntryView {
    pub owner: AccountId,
    pub asset: String,
    pub amount: U128,
    pub status: HeldStatusView,
    pub retries: u8,
    pub destination: Option<DestinationView>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct PayoutView {
    pub id: u64,
    pub module: String,
    pub reference: String,
    pub source: AccountId,
    pub asset: String,
    pub amount_in: U128,
    pub deposit_address: AccountId,
    pub status: String,
}

/// Helper: query `settlement_of(account_id)`.
async fn get_settlement(env: &Env, account_id: &AccountId) -> Result<Option<DestinationView>> {
    let dest: Option<DestinationView> = env
        .root
        .view("settlement_of")
        .args_json(json!({ "account_id": account_id }))
        .await?
        .json()?;
    Ok(dest)
}

/// Helper: query `settle_held(token_id)`.
async fn get_settle_held(env: &Env, token_id: &str) -> Result<Vec<HeldEntryView>> {
    let held: Vec<HeldEntryView> = env
        .root
        .view("settle_held")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    Ok(held)
}

/// Helper: query `claim(token_id)`.
async fn get_claim(env: &Env, token_id: &str) -> Result<ClaimView> {
    let cv: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    cv.context("claim not found")
}

/// 1. Real vault v2 forward on a claim account through payout support component.
///
/// Verifies:
/// - Settle hook holds Alice's share on `c-1` when settlement destination is configured.
/// - Settle payout calls payout support component, invoking vault v2 forward on `c-1.openrail.near`.
/// - Vault forward transfers multi-token balance on `intents.near` to deposit address.
/// - Lock transition to `Module { id: "settle", .. }`.
/// - Report payout marks entry settled and releases the lock.
#[tokio::test]
async fn test_real_vault_forward_through_payout_sandbox() -> Result<()> {
    let env = Env::new().await?;

    // 1. Root registers watcher as authorized payout relayer
    let set_relayers_res = env
        .root
        .call("set_payout_relayers")
        .args_json(json!({ "relayers": [env.watcher.id()] }))
        .max_gas()
        .transact()
        .await?;
    assert!(set_relayers_res.is_success());

    // 2. Business Alice configures settlement to Base
    let set_settle_res = env
        .alice
        .call(env.root.id(), "set_settlement")
        .args_json(json!({
            "chain": "base",
            "address": "0x1111111111111111111111111111111111111111",
            "min_amount": U128(100_000), // $0.10 minimum
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(set_settle_res.is_success());

    let dest = get_settlement(&env, env.alice.id()).await?.expect("destination set");
    assert_eq!(dest.chain, "base");
    assert_eq!(dest.address, "0x1111111111111111111111111111111111111111");

    // 3. Issue claim c-1 for $1.00 USDC (1,000,000 base units)
    let issue_res = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000)
        .await?;
    assert!(issue_res.is_success());

    // 4. Payer deposits 1,000,000 USDC into c-1 vault subaccount on intents.near
    let _ = env.fund_claim("c-1", 1_000_000, None).await?;
    assert_eq!(env.claim_balance("c-1", None).await?, 1_000_000);

    // 5. Reconcile c-1
    let rec_res = env
        .call_as(&env.watcher)
        .call_root("reconcile", json!({ "token_id": "c-1" }), ZERO_NEAR)
        .await?;
    assert!(rec_res.is_success());

    let cv = get_claim(&env, "c-1").await?;
    assert_eq!(cv.status, Status::Paid);
    assert_eq!(cv.booked_total.0, 1_000_000);
    assert_eq!(cv.fee_total.0, 2_500); // 25 bps
    assert_eq!(cv.distributed_total.0, 997_500); // Net is booked into distributed_total

    // Held entry was recorded
    let held = get_settle_held(&env, "c-1").await?;
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].amount.0, 997_500);
    assert_eq!(held[0].owner, *env.alice.id());
    assert_eq!(held[0].asset, DEFAULT_SETTLEMENT_ASSET);
    assert_eq!(held[0].status, HeldStatusView::Held);

    // Intended funds (997,500) remain in c-1's vault subaccount on intents.near
    assert_eq!(env.claim_balance("c-1", None).await?, 997_500);

    // Initial deposit target balance (Bob) is 0
    let bob_init_bal: U128 = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({
            "account_id": env.bob.id(),
            "token_id": DEFAULT_SETTLEMENT_ASSET,
        }))
        .await?
        .json()?;
    assert_eq!(bob_init_bal.0, 0);

    // 6. Relayer calls settle_payout
    let payout_res = env
        .call_as(&env.watcher)
        .call_root(
            "settle_payout",
            json!({
                "token_id": "c-1",
                "index": 0,
                "deposit_address": env.bob.id(),
                "amount_in": U128(997_500),
            }),
            ZERO_NEAR,
        )
        .await?;
    assert!(payout_res.is_success());

    let payout_id: u64 = payout_res.json()?;

    // 7. Verify real vault v2 forward took effect on intents.near
    // c-1 balance dropped to 0
    assert_eq!(env.claim_balance("c-1", None).await?, 0);

    // Bob (the deposit target) received the forwarded funds
    let bob_final_bal: U128 = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({
            "account_id": env.bob.id(),
            "token_id": DEFAULT_SETTLEMENT_ASSET,
        }))
        .await?
        .json()?;
    assert_eq!(bob_final_bal.0, 997_500);

    // Claim is locked under Module { id: "settle", .. }
    let cv_locked = get_claim(&env, "c-1").await?;
    match cv_locked.lock {
        Lock::Module { ref id, .. } => assert_eq!(id, "settle"),
        other => panic!("expected Module lock, got {:?}", other),
    }

    // Held entry status is InFlight
    let held_inflight = get_settle_held(&env, "c-1").await?;
    assert_eq!(
        held_inflight[0].status,
        HeldStatusView::InFlight { payout_id }
    );

    // 8. Relayer reports payout Settled
    let report_res = env
        .call_as(&env.watcher)
        .call_root(
            "report_payout",
            json!({
                "token_id": "c-1",
                "index": 0,
                "payout_id": payout_id,
                "outcome": {
                    "outcome": "settled",
                    "destination_tx": "0xbase_sample_tx_hash_123",
                },
            }),
            ZERO_NEAR,
        )
        .await?;
    assert!(report_res.is_success());

    // Lock is cleared to None
    let cv_settled = get_claim(&env, "c-1").await?;
    assert_eq!(cv_settled.lock, Lock::None);

    // Held status is Settled
    let held_settled = get_settle_held(&env, "c-1").await?;
    assert_eq!(
        held_settled[0].status,
        HeldStatusView::Settled {
            payout_id,
            destination_tx: "0xbase_sample_tx_hash_123".to_string(),
        }
    );

    Ok(())
}

/// 2. `payout_batch_fits_gas` measured in the sandbox.
///
/// Measures real Tgas burnt across all receipts for 1 payout and determines
/// safe `MAX_PAYOUTS_PER_CALL` with a 20% margin under the 300 Tgas limit.
#[tokio::test]
async fn test_payout_batch_fits_gas_measured() -> Result<()> {
    let env = Env::new().await?;

    let set_relayers_res = env
        .root
        .call("set_payout_relayers")
        .args_json(json!({ "relayers": [env.watcher.id()] }))
        .max_gas()
        .transact()
        .await?;
    assert!(set_relayers_res.is_success());

    let _ = env
        .alice
        .call(env.root.id(), "set_settlement")
        .args_json(json!({
            "chain": "base",
            "address": "0x2222222222222222222222222222222222222222",
            "min_amount": U128(100_000),
        }))
        .max_gas()
        .transact()
        .await?;

    let _ = env.issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000).await?;
    let _ = env.fund_claim("c-1", 1_000_000, None).await?;
    let _ = env
        .call_as(&env.watcher)
        .call_root("reconcile", json!({ "token_id": "c-1" }), ZERO_NEAR)
        .await?;

    // Measure settle_payout call
    let payout_res = env
        .call_as(&env.watcher)
        .call_root(
            "settle_payout",
            json!({
                "token_id": "c-1",
                "index": 0,
                "deposit_address": env.bob.id(),
                "amount_in": U128(997_500),
            }),
            ZERO_NEAR,
        )
        .await?;
    assert!(payout_res.is_success());

    let total_gas_burnt = payout_res.total_gas_burnt.as_gas();
    let total_tgas_burnt = total_gas_burnt as f64 / 1_000_000_000_000.0;

    println!("--------------------------------------------------");
    println!("MEASURED PAYOUT GAS CONSUMPTION (SANDBOX):");
    println!("Total gas burnt for 1 payout: {} gas ({:.3} Tgas)", total_gas_burnt, total_tgas_burnt);

    // 300 Tgas available for a call. With a 20% margin, budget is 300 * 0.8 = 240 Tgas.
    let safe_max_payouts = (240.0 / total_tgas_burnt).floor() as u64;
    println!("Safe MAX_PAYOUTS_PER_CALL (240 Tgas budget): {}", safe_max_payouts);
    println!("Author's static limit: 7");
    println!("_payout.md planned limit: 14");
    println!("--------------------------------------------------");

    // Payout execution must be efficient (well within 35 Tgas per payout)
    assert!(total_tgas_burnt < 35.0, "payout burnt {:.3} Tgas, exceeding 35 Tgas ceiling", total_tgas_burnt);
    // At least 7 payouts must fit within the 240 Tgas safe budget
    assert!(safe_max_payouts >= 7, "safe_max_payouts {} < 7", safe_max_payouts);

    Ok(())
}

/// 3. C4 reconcile regression: Hold leg split across two settlement assets by capacity.
///
/// Verifies:
/// - Claim receives 600,000 in Asset 1 and 400,000 in Asset 2. Total booked = 1,000,000.
/// - Net = 997,500, Fee = 2,500.
/// - Hold leg consumes capacity: 600,000 from Asset 1 and 397,500 from Asset 2.
/// - Fee leg consumes remaining 2,500 from Asset 2.
/// - Fee is forwarded to fee account; neither Hold leg is forwarded.
/// - `settle_held` records two distinct held entries with the respective assets and amounts.
/// - Reconcile is strictly idempotent on zero delta.
#[tokio::test]
async fn test_c4_reconcile_regression_hold_leg_across_two_assets() -> Result<()> {
    let env = Env::new().await?;

    let set_relayers_res = env
        .root
        .call("set_payout_relayers")
        .args_json(json!({ "relayers": [env.watcher.id()] }))
        .max_gas()
        .transact()
        .await?;
    assert!(set_relayers_res.is_success());

    let _ = env
        .alice
        .call(env.root.id(), "set_settlement")
        .args_json(json!({
            "chain": "base",
            "address": "0x3333333333333333333333333333333333333333",
            "min_amount": U128(100_000),
        }))
        .max_gas()
        .transact()
        .await?;

    let _ = env.issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000).await?;

    // Fund with two distinct settlement assets:
    // Asset 1 (USDC): 600,000
    // Asset 2 (Base OMFT): 400,000
    let _ = env.fund_claim("c-1", 600_000, Some(DEFAULT_SETTLEMENT_ASSET)).await?;
    let _ = env.fund_claim("c-1", 400_000, Some(BASE_ASSET)).await?;

    let rec_res = env
        .call_as(&env.watcher)
        .call_root("reconcile", json!({ "token_id": "c-1" }), ZERO_NEAR)
        .await?;
    assert!(rec_res.is_success());

    let cv = get_claim(&env, "c-1").await?;
    assert_eq!(cv.status, Status::Paid);
    assert_eq!(cv.booked_total.0, 1_000_000);
    assert_eq!(cv.fee_total.0, 2_500);

    // Fee was forwarded from Asset 2
    let fee_bal: U128 = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({
            "account_id": env.fees.id(),
            "token_id": BASE_ASSET,
        }))
        .await?
        .json()?;
    assert_eq!(fee_bal.0, 2_500);

    // Settle module recorded two held entries for c-1
    let held = get_settle_held(&env, "c-1").await?;
    assert_eq!(held.len(), 2, "must hold across two assets");

    assert_eq!(held[0].asset, DEFAULT_SETTLEMENT_ASSET);
    assert_eq!(held[0].amount.0, 600_000);
    assert_eq!(held[0].status, HeldStatusView::Held);

    assert_eq!(held[1].asset, BASE_ASSET);
    assert_eq!(held[1].amount.0, 397_500);
    assert_eq!(held[1].status, HeldStatusView::Held);

    // Intended funds remain intact in the claim account on intents.near
    assert_eq!(env.claim_balance("c-1", Some(DEFAULT_SETTLEMENT_ASSET)).await?, 600_000);
    assert_eq!(env.claim_balance("c-1", Some(BASE_ASSET)).await?, 397_500);

    // Zero-delta reconcile is strictly idempotent
    let rec_zero = env
        .call_as(&env.watcher)
        .call_root("reconcile", json!({ "token_id": "c-1" }), ZERO_NEAR)
        .await?;
    assert!(rec_zero.is_success());

    // Both held entries can be paid out sequentially
    let p0 = env
        .call_as(&env.watcher)
        .call_root(
            "settle_payout",
            json!({
                "token_id": "c-1",
                "index": 0,
                "deposit_address": env.bob.id(),
                "amount_in": U128(600_000),
            }),
            ZERO_NEAR,
        )
        .await?;
    assert!(p0.is_success());
    let id0: u64 = p0.json()?;

    let rep0 = env
        .call_as(&env.watcher)
        .call_root(
            "report_payout",
            json!({
                "token_id": "c-1",
                "index": 0,
                "payout_id": id0,
                "outcome": {
                    "outcome": "settled",
                    "destination_tx": "0xtx0",
                },
            }),
            ZERO_NEAR,
        )
        .await?;
    assert!(rep0.is_success());

    let p1 = env
        .call_as(&env.watcher)
        .call_root(
            "settle_payout",
            json!({
                "token_id": "c-1",
                "index": 1,
                "deposit_address": env.bob.id(),
                "amount_in": U128(397_500),
            }),
            ZERO_NEAR,
        )
        .await?;
    assert!(p1.is_success());
    let id1: u64 = p1.json()?;

    let rep1 = env
        .call_as(&env.watcher)
        .call_root(
            "report_payout",
            json!({
                "token_id": "c-1",
                "index": 1,
                "payout_id": id1,
                "outcome": {
                    "outcome": "settled",
                    "destination_tx": "0xtx1",
                },
            }),
            ZERO_NEAR,
        )
        .await?;
    assert!(rep1.is_success());

    Ok(())
}

/// 4. Review point 1: `release_surplus` spends from `last_seen_balance` which includes held value.
///
/// Demonstrates that if surplus arises in Asset 2 while Asset 1 is held by settle,
/// core `release_surplus` iterates settlement assets in order and takes from Asset 1
/// (the held asset), depleting the claim account and causing `settle_payout` to fail.
#[tokio::test]
async fn test_review_release_surplus_spends_held_value() -> Result<()> {
    let env = Env::new().await?;

    let set_relayers_res = env
        .root
        .call("set_payout_relayers")
        .args_json(json!({ "relayers": [env.watcher.id()] }))
        .max_gas()
        .transact()
        .await?;
    assert!(set_relayers_res.is_success());

    let _ = env
        .alice
        .call(env.root.id(), "set_settlement")
        .args_json(json!({
            "chain": "base",
            "address": "0x4444444444444444444444444444444444444444",
            "min_amount": U128(100_000),
        }))
        .max_gas()
        .transact()
        .await?;

    let _ = env.issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000).await?;

    // 1. Initial payment in Asset 1 (USDC): 1,000,000
    let _ = env.fund_claim("c-1", 1_000_000, Some(DEFAULT_SETTLEMENT_ASSET)).await?;
    let _ = env
        .call_as(&env.watcher)
        .call_root("reconcile", json!({ "token_id": "c-1" }), ZERO_NEAR)
        .await?;

    let cv = get_claim(&env, "c-1").await?;
    assert_eq!(cv.status, Status::Paid);
    assert_eq!(cv.surplus.0, 0);

    let held_before = get_settle_held(&env, "c-1").await?;
    assert_eq!(held_before[0].amount.0, 997_500);
    assert_eq!(held_before[0].asset, DEFAULT_SETTLEMENT_ASSET);

    // 2. Extra payment arrives in Asset 2 (Base OMFT): 200,000
    let _ = env.fund_claim("c-1", 200_000, Some(BASE_ASSET)).await?;
    let _ = env
        .call_as(&env.watcher)
        .call_root("reconcile", json!({ "token_id": "c-1" }), ZERO_NEAR)
        .await?;

    let cv_surplus = get_claim(&env, "c-1").await?;
    assert_eq!(cv_surplus.surplus.0, 200_000);

    // 3. Alice calls release_surplus
    // Core iterates settlement_assets: [DEFAULT_SETTLEMENT_ASSET, BASE_ASSET, ..]
    // DEFAULT_SETTLEMENT_ASSET has last_seen_balance = 997_500.
    // Core takes 200,000 from DEFAULT_SETTLEMENT_ASSET and forwards it to Alice!
    let rel_surplus_res = env
        .alice
        .call(env.root.id(), "release_surplus")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(rel_surplus_res.is_success());

    // Claim account on intents.near now holds only 797,500 of Asset 1!
    let asset1_bal = env.claim_balance("c-1", Some(DEFAULT_SETTLEMENT_ASSET)).await?;
    assert_eq!(asset1_bal, 797_500, "Asset 1 was drained by release_surplus");

    // 4. Now the relayer attempts to execute the 997,500 payout for held entry 0
    let payout_attempt = env
        .call_as(&env.watcher)
        .call_root(
            "settle_payout",
            json!({
                "token_id": "c-1",
                "index": 0,
                "deposit_address": env.bob.id(),
                "amount_in": U128(997_500),
            }),
            ZERO_NEAR,
        )
        .await?;

    // Must fail because last_seen_balance of Asset 1 is only 797,500 (< 997,500)
    assert!(
        payout_attempt.is_failure(),
        "settle_payout must be refused when held asset was drained by release_surplus"
    );

    println!("--------------------------------------------------");
    println!("REVIEW POINT 1 CONFIRMED:");
    println!("release_surplus spent 200,000 of Asset 1 (held by settle), causing settle_payout refusal");
    println!("--------------------------------------------------");

    Ok(())
}

/// 5. Review point 2: Lock expires before `report_payout` and refund arrives.
///
/// Demonstrates what happens when:
/// - Payout is in flight, locking claim for 600 blocks.
/// - Lock expires past 600 blocks and is cleared by `clear_stale_lock`.
/// - Refund arrives on the claim account.
/// - Next reconcile books the refund as surplus on the Paid claim.
/// - `report_payout(Refunded)` then runs and adds to `last_seen_balance` again,
///   creating a double-credit state discrepancy!
#[tokio::test]
async fn test_review_lock_expires_before_report_payout() -> Result<()> {
    let env = Env::new().await?;

    let set_relayers_res = env
        .root
        .call("set_payout_relayers")
        .args_json(json!({ "relayers": [env.watcher.id()] }))
        .max_gas()
        .transact()
        .await?;
    assert!(set_relayers_res.is_success());

    let _ = env
        .alice
        .call(env.root.id(), "set_settlement")
        .args_json(json!({
            "chain": "base",
            "address": "0x5555555555555555555555555555555555555555",
            "min_amount": U128(100_000),
        }))
        .max_gas()
        .transact()
        .await?;

    let _ = env.issue_claim(&env.alice, 0, 1_000_000, 1_800_000_000).await?;
    let _ = env.fund_claim("c-1", 1_000_000, None).await?;
    let _ = env
        .call_as(&env.watcher)
        .call_root("reconcile", json!({ "token_id": "c-1" }), ZERO_NEAR)
        .await?;

    // 1. Relayer sends payout (forwards 997,500 USDC to Bob)
    let p_res = env
        .call_as(&env.watcher)
        .call_root(
            "settle_payout",
            json!({
                "token_id": "c-1",
                "index": 0,
                "deposit_address": env.bob.id(),
                "amount_in": U128(997_500),
            }),
            ZERO_NEAR,
        )
        .await?;
    assert!(p_res.is_success());
    let payout_id: u64 = p_res.json()?;

    // Claim account balance is 0; last_seen_balance is 0
    assert_eq!(env.claim_balance("c-1", None).await?, 0);

    // 2. Advance 650 blocks past the 600-block lock
    env.advance_blocks(650).await?;

    // 3. Clear the stale lock
    let clear_res = env
        .alice
        .call(env.root.id(), "clear_stale_lock")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(clear_res.is_success());

    let cv_cleared = get_claim(&env, "c-1").await?;
    assert_eq!(cv_cleared.lock, Lock::None);

    // 4. 1Click refund arrives on c-1.openrail.near (997,500 USDC)
    let _ = env.fund_claim("c-1", 997_500, None).await?;
    assert_eq!(env.claim_balance("c-1", None).await?, 997_500);

    // 5. Watcher reconciles because lock is None
    let rec_refund = env
        .call_as(&env.watcher)
        .call_root("reconcile", json!({ "token_id": "c-1" }), ZERO_NEAR)
        .await?;
    assert!(rec_refund.is_success());

    let cv_reconciled = get_claim(&env, "c-1").await?;
    println!("--------------------------------------------------");
    println!("REVIEW POINT 2: STATE AFTER RECONCILE OF REFUND:");
    println!("Booked total: {}", cv_reconciled.booked_total.0);
    println!("Surplus: {}", cv_reconciled.surplus.0);
    println!("--------------------------------------------------");

    // Refund was booked as surplus!
    assert_eq!(cv_reconciled.surplus.0, 997_500);
    assert_eq!(cv_reconciled.booked_total.0, 1_997_500);

    // 6. Now relayer reports Refunded
    let rep_refund = env
        .call_as(&env.watcher)
        .call_root(
            "report_payout",
            json!({
                "token_id": "c-1",
                "index": 0,
                "payout_id": payout_id,
                "outcome": {
                    "outcome": "refunded",
                    "amount": U128(997_500),
                },
            }),
            ZERO_NEAR,
        )
        .await?;
    assert!(rep_refund.is_success());

    // Check held entries
    let held_after = get_settle_held(&env, "c-1").await?;
    println!("Held entry retries: {}, status: {:?}", held_after[0].retries, held_after[0].status);
    assert_eq!(held_after[0].status, HeldStatusView::Held);
    assert_eq!(held_after[0].retries, 1);

    Ok(())
}
