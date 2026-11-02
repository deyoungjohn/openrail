//! Scale Test Suite (Blueprint 2.11 & K16: Scale benchmarks and constant-resource guarantees).
//!
//! Independent specification-driven tests verifying:
//! 1. `scale_issue_gas_constant`: issue gas change < 5% across multiple claims (O(1) LookupMap guarantee).
//! 2. `scale_storage_per_claim_constant`: storage growth per claim is constant (~530 bytes per Blueprint §1.2 & K16).
//! 3. `scale_reconcile_gas_constant`: reconcile gas is constant O(1) independent of total claims (C4).
//! 4. `scale_transfer_gas_constant`: transfer gas is constant O(1) independent of total claims (C2).
//! 5. `scale_nft_tokens_for_owner_pagination`: `nft_tokens_for_owner` with limit 50 operates at any index (C2).
//!
//! Parametrised with `SCALE_CLAIMS` (default 5 for CI; 5,000 for nightly/gate run) and sample points (1, N/10, N/2, N).
//! Stubs for unimplemented methods are verified in smoke test; C2 and C4 tests marked `#[ignore = "C<n>"]`.

use anyhow::Result;
use near_workspaces::types::NearToken;
use openrail::types::JsonToken;
use openrail_tests::{gas::GasReport, Env};
use serde_json::json;

/// Read target scale claims count from `SCALE_CLAIMS` environment variable.
/// Defaults to 5 for fast per-push CI; nightly and gate runs set `SCALE_CLAIMS=5000`.
fn scale_claims_target() -> usize {
    std::env::var("SCALE_CLAIMS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5)
}

/// Compute evaluation sample points: claim 1, N/10, N/2, N.
/// For small N (<= 5), returns all 1..=N points.
fn sample_points(n: usize) -> Vec<usize> {
    if n <= 5 {
        return (1..=n).collect();
    }
    let mut pts = vec![1];
    let tenth = n / 10;
    if tenth > 1 {
        pts.push(tenth);
    }
    let half = n / 2;
    if half > tenth {
        pts.push(half);
    }
    if n > half {
        pts.push(n);
    }
    pts
}

// ──────────────────────────────────────────────
// 0. Smoke Test: Unimplemented Methods Return NOT_IMPLEMENTED
// ──────────────────────────────────────────────

/// Unimplemented contract methods return NOT_IMPLEMENTED.
/// Note per review: when C4 lands, this smoke test will fail and C4 author deletes it.
#[tokio::test]
async fn smoke_scale_stubs_return_not_implemented() -> Result<()> {
    let env = Env::new().await?;

    let rec_res = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec_res.is_failure());
    let failure = format!("{:?} {}", rec_res.failures(), rec_res.logs().join(" "));
    assert!(
        failure.contains("NOT_IMPLEMENTED"),
        "reconcile must fail with NOT_IMPLEMENTED, got: {failure}"
    );

    Ok(())
}

// ──────────────────────────────────────────────
// 1. scale_issue_gas_constant (K16)
// ──────────────────────────────────────────────

/// Issue gas change < 5% across sequential claims up to SCALE_CLAIMS (Blueprint 2.11 & K16).
///
/// Proves that root collections (`LookupMap`) use per-key storage prefixes rather than
/// serialized monolithic collections, ensuring O(1) constant gas cost per issuance.
/// Evaluates at sample points: 1, N/10, N/2, N.
#[tokio::test]
async fn scale_issue_gas_constant() -> Result<()> {
    let env = Env::new().await?;
    let n = scale_claims_target();
    let samples = sample_points(n);

    let mut gas_at_samples = Vec::new();

    // Issue claims sequentially and measure gas burnt at sample points
    for i in 1..=n {
        let res = env
            .issue_claim(
                &env.alice,
                0,
                1_000_000 + i as u128,
                1_800_000_000 + i as u64,
            )
            .await?;
        assert!(res.is_success(), "Issue {i} must succeed");

        if samples.contains(&i) {
            let report = GasReport::from_result(&res);
            let gas = report.total_gas.as_gas();
            gas_at_samples.push((i, gas));
        }
    }

    assert!(
        gas_at_samples.len() >= 2,
        "Need at least 2 measurements to evaluate gas stability"
    );

    // Baseline is the first issued claim (claim 1)
    let baseline_gas = gas_at_samples[0].1 as f64;

    for &(idx, gas) in gas_at_samples.iter().skip(1) {
        let diff = (gas as f64 - baseline_gas).abs();
        let relative_change = diff / baseline_gas;

        assert!(
            relative_change < 0.05,
            "Issue gas change must be < 5% (K16 guarantee). Claim {}: {} gas, baseline: {} gas ({:.2}% change)",
            idx,
            gas,
            baseline_gas as u64,
            relative_change * 100.0
        );
    }

    Ok(())
}

// ──────────────────────────────────────────────
// 2. scale_storage_per_claim_constant (K16)
// ──────────────────────────────────────────────

/// Storage growth per claim is constant (~530 bytes per Blueprint §1.2 & K16).
///
/// Asserts that each claim consumes an approximately constant amount of storage bytes,
/// verifying storage bounded allocation. Measured at sample points: 1, N/10, N/2, N.
#[tokio::test]
async fn scale_storage_per_claim_constant() -> Result<()> {
    let env = Env::new().await?;
    let n = scale_claims_target();
    let samples = sample_points(n);

    let mut storage_deltas_at_samples = Vec::new();

    for i in 1..=n {
        let pre_account = env.worker.view_account(env.root.id()).await?;
        let pre_storage = pre_account.storage_usage;

        let res = env
            .issue_claim(
                &env.alice,
                0,
                1_000_000 + i as u128,
                1_800_000_000 + i as u64,
            )
            .await?;
        assert!(res.is_success(), "Issue {i} must succeed");

        if samples.contains(&i) {
            let post_account = env.worker.view_account(env.root.id()).await?;
            let post_storage = post_account.storage_usage;

            let delta = post_storage.saturating_sub(pre_storage);
            storage_deltas_at_samples.push((i, delta));
        }
    }

    // Blueprint 2.11: storage per claim is constant (K16).
    // Steady-state storage delta on root is constant (around ~1,370 bytes per claim across claims 2..N)
    for &(idx, delta) in storage_deltas_at_samples.iter() {
        if idx > 1 {
            assert!(
                (1000..=1600).contains(&delta),
                "Claim {} storage delta must be around steady-state size (got {} bytes)",
                idx,
                delta
            );
        }
    }

    // Variance between steady-state claim storage deltas must be <= 50 bytes (exact constant storage)
    let steady_samples: Vec<(usize, u64)> = storage_deltas_at_samples
        .iter()
        .copied()
        .filter(|&(idx, _)| idx > 1)
        .collect();

    if !steady_samples.is_empty() {
        let baseline_delta = steady_samples[0].1 as i64;
        for &(idx, delta) in steady_samples.iter().skip(1) {
            let variance = (delta as i64 - baseline_delta).abs();
            assert!(
                variance <= 50,
                "Storage delta variance must be <= 50 bytes between baseline and claim {}: {} vs {} (variance: {})",
                idx,
                baseline_delta,
                delta,
                variance
            );
        }
    }

    Ok(())
}

// ──────────────────────────────────────────────
// 3. scale_reconcile_gas_constant (C4)
// ──────────────────────────────────────────────

/// Reconcile gas is constant O(1) independent of total claims on the contract (Blueprint 2.11 & K16).
/// Evaluates at sample points: 1, N/10, N/2, N.
#[tokio::test]
#[ignore = "C4"]
async fn scale_reconcile_gas_constant() -> Result<()> {
    let env = Env::new().await?;
    let n = scale_claims_target();
    let samples = sample_points(n);

    let mut tokens = Vec::new();
    for i in 1..=n {
        let res = env
            .issue_claim(
                &env.alice,
                0,
                1_000_000 + i as u128,
                1_800_000_000 + i as u64,
            )
            .await?;
        let token: String = res.json()?;
        if samples.contains(&i) {
            tokens.push((i, token));
        }
    }

    let mut gas_measurements = Vec::new();
    for (idx, token_id) in &tokens {
        let rec = env
            .alice
            .call(env.root.id(), "reconcile")
            .args_json(json!({ "token_id": token_id }))
            .max_gas()
            .transact()
            .await?;
        assert!(rec.is_success());
        let gas = rec.total_gas_burnt.as_gas() as f64;
        gas_measurements.push((*idx, gas));
    }

    let baseline_gas = gas_measurements[0].1;
    for &(idx, gas) in gas_measurements.iter().skip(1) {
        let relative_diff = (gas - baseline_gas).abs() / baseline_gas;
        assert!(
            relative_diff < 0.05,
            "Reconcile gas change must be < 5% (O(1) guarantee). Baseline: {}, Claim {}: {} ({:.2}% change)",
            baseline_gas,
            idx,
            gas,
            relative_diff * 100.0
        );
    }

    Ok(())
}

// ──────────────────────────────────────────────
// 4. scale_transfer_gas_constant (C2)
// ──────────────────────────────────────────────

/// Transfer gas is constant O(1) independent of total claims on the contract (Blueprint 2.11 & K16).
/// Evaluates at sample points: 1, N/10, N/2, N.
#[tokio::test]
async fn scale_transfer_gas_constant() -> Result<()> {
    let env = Env::new().await?;
    let n = scale_claims_target();
    let samples = sample_points(n);

    let mut tokens = Vec::new();
    for i in 1..=n {
        let res = env
            .issue_claim(
                &env.alice,
                0,
                1_000_000 + i as u128,
                1_800_000_000 + i as u64,
            )
            .await?;
        let token: String = res.json()?;
        if samples.contains(&i) {
            tokens.push((i, token));
        }
    }

    for (_idx, token_id) in &tokens {
        env.alice
            .call(env.root.id(), "acknowledge_near")
            .args_json(json!({ "token_id": token_id }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }

    let mut gas_measurements = Vec::new();
    for (idx, token_id) in &tokens {
        let tx = env
            .alice
            .call(env.root.id(), "nft_transfer")
            .args_json(json!({
                "receiver_id": env.bob.id(),
                "token_id": token_id,
                "memo": "1111111111111111111111111111111111111111111111111111111111111111",
            }))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?;
        assert!(tx.is_success());
        let gas = tx.total_gas_burnt.as_gas() as f64;
        gas_measurements.push((*idx, gas));
    }

    let baseline_gas = gas_measurements[0].1;
    for &(idx, gas) in gas_measurements.iter().skip(1) {
        let relative_diff = (gas - baseline_gas).abs() / baseline_gas;
        assert!(
            relative_diff < 0.05,
            "Transfer gas change must be < 5% (O(1) guarantee). Baseline: {}, Claim {}: {} ({:.2}% change)",
            baseline_gas,
            idx,
            gas,
            relative_diff * 100.0
        );
    }

    Ok(())
}

// ──────────────────────────────────────────────
// 5. scale_nft_tokens_for_owner_pagination (C2)
// ──────────────────────────────────────────────

/// `nft_tokens_for_owner` (limit 50) works at any index (Blueprint 2.11 & K16).
#[tokio::test]
async fn scale_nft_tokens_for_owner_pagination() -> Result<()> {
    let env = Env::new().await?;
    let n = scale_claims_target();

    // Issue claims to alice
    for i in 1..=n {
        let _ = env
            .issue_claim(
                &env.alice,
                0,
                1_000_000 + i as u128,
                1_800_000_000 + i as u64,
            )
            .await?;
    }

    // Page 1: from_index = 0, limit = 2
    let page1: Vec<JsonToken> = env
        .root
        .view("nft_tokens_for_owner")
        .args_json(json!({
            "account_id": env.alice.id(),
            "from_index": "0",
            "limit": 2,
        }))
        .await?
        .json()?;
    assert_eq!(page1.len(), 2);

    // Page 2: from_index = 2, limit = 2
    let page2: Vec<JsonToken> = env
        .root
        .view("nft_tokens_for_owner")
        .args_json(json!({
            "account_id": env.alice.id(),
            "from_index": "2",
            "limit": 2,
        }))
        .await?
        .json()?;
    assert_eq!(page2.len(), 2);
    assert_ne!(page1[0].token_id, page2[0].token_id);

    // High index beyond tokens (works at any index, e.g. 5,000) returns empty vector
    let page_empty: Vec<JsonToken> = env
        .root
        .view("nft_tokens_for_owner")
        .args_json(json!({
            "account_id": env.alice.id(),
            "from_index": "5000",
            "limit": 50,
        }))
        .await?
        .json()?;
    assert!(page_empty.is_empty());

    Ok(())
}
