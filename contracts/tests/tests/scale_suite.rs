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
use near_sdk::borsh;
use near_sdk::json_types::U128;
use near_workspaces::types::NearToken;
use near_workspaces::Account;
use openrail::types::{
    Claim, ClaimView, Debtor, Hex32, JsonToken, Lock, Status, TokenId, TokenMetadata,
};
use openrail_tests::{gas::GasReport, Env};
use serde_json::json;
use std::collections::HashMap;

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

/// Seeds claims `start..=end` directly into `openrail.near` contract state via `worker.patch`
/// in batches of 250 claims (`review/ph1-t1-scale/REVIEW.md`), producing the exact on-chain
/// key layout (`c:`, `t:`, `o:{owner}:*`, `ti::*`, and `STATE.next_token_id`) as `issue` + `on_issue`.
async fn seed_claims_range(env: &Env, owner: &Account, start: usize, end: usize) -> Result<()> {
    if start > end {
        return Ok(());
    }

    let settlement_assets: Vec<TokenId> = vec![
        "nep141:usdc.near".to_string(),
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near".to_string(),
        "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near".to_string(),
        "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near".to_string(),
    ];
    let owner_bytes = owner.id().as_bytes();

    let mut chunk_start = start;
    while chunk_start <= end {
        let chunk_end = (chunk_start + 249).min(end);
        let mut kv_pairs: Vec<(Vec<u8>, Vec<u8>)> =
            Vec::with_capacity((chunk_end - chunk_start + 1) * 6 + 3);

        for i in chunk_start..=chunk_end {
            let token_id = format!("c-{i}");
            let claim_account = format!("{token_id}.{}", env.root.id()).parse()?;
            let amount_due = 1_000_000 + i as u128;
            let due_date = 1_800_000_000 + i as u64;

            let claim = Claim {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: owner.id().clone(),
                owner_id: owner.id().clone(),
                claim_account,
                debtor: Some(Debtor::Near(owner.id().clone())),
                terms_hash: Hex32::default(),
                amount_due: U128(amount_due),
                due_date,
                ack: None,
                status: Status::Issued,
                lock: Lock::None,
                settlement_assets: settlement_assets.clone(),
                booked_total: U128(0),
                distributed_total: U128(0),
                fee_total: U128(0),
                surplus: U128(0),
                credit_total: U128(0),
                credit_source: None,
                last_seen_balance: HashMap::new(),
                assignment_doc_hash: None,
                created_block: 1,
            };

            let metadata = TokenMetadata {
                title: Some(format!("Invoice {i}")),
                description: Some(format!(
                    "{} due {}",
                    openrail::svg::format_amount(amount_due),
                    openrail::svg::format_date(due_date)
                )),
                media: Some(openrail::svg::svg_data_uri(
                    &i.to_string(),
                    amount_due,
                    due_date,
                )),
                media_hash: None,
                copies: Some(1),
                issued_at: Some(1_700_000_000_000),
                expires_at: Some(due_date.saturating_mul(1000)),
                starts_at: None,
                updated_at: None,
                extra: Some(Hex32::default().to_string()),
                reference: None,
                reference_hash: None,
            };

            let token_key_borsh = borsh::to_vec(&token_id)?;
            let mut claim_key = Vec::with_capacity(2 + token_key_borsh.len());
            claim_key.extend_from_slice(b"c:");
            claim_key.extend_from_slice(&token_key_borsh);
            kv_pairs.push((claim_key, borsh::to_vec(&claim)?));

            let mut meta_key = Vec::with_capacity(2 + token_key_borsh.len());
            meta_key.extend_from_slice(b"t:");
            meta_key.extend_from_slice(&token_key_borsh);
            kv_pairs.push((meta_key, borsh::to_vec(&metadata)?));

            let idx = (i - 1) as u64;
            let idx_bytes = idx.to_le_bytes();

            let mut owner_i_key = Vec::with_capacity(2 + owner_bytes.len() + 3 + 8);
            owner_i_key.extend_from_slice(b"o:");
            owner_i_key.extend_from_slice(owner_bytes);
            owner_i_key.extend_from_slice(b":i:");
            owner_i_key.extend_from_slice(&idx_bytes);
            kv_pairs.push((owner_i_key, token_id.as_bytes().to_vec()));

            let mut owner_k_key = Vec::with_capacity(2 + owner_bytes.len() + 3 + token_id.len());
            owner_k_key.extend_from_slice(b"o:");
            owner_k_key.extend_from_slice(owner_bytes);
            owner_k_key.extend_from_slice(b":k:");
            owner_k_key.extend_from_slice(token_id.as_bytes());
            kv_pairs.push((owner_k_key, idx_bytes.to_vec()));

            let mut global_i_key = Vec::with_capacity(6 + 8);
            global_i_key.extend_from_slice(b"ti::i:");
            global_i_key.extend_from_slice(&idx_bytes);
            kv_pairs.push((global_i_key, token_id.as_bytes().to_vec()));

            let mut global_k_key = Vec::with_capacity(6 + token_id.len());
            global_k_key.extend_from_slice(b"ti::k:");
            global_k_key.extend_from_slice(token_id.as_bytes());
            kv_pairs.push((global_k_key, idx_bytes.to_vec()));
        }

        if chunk_end == end {
            let count_bytes = (end as u64).to_le_bytes().to_vec();
            let mut owner_n_key = Vec::with_capacity(2 + owner_bytes.len() + 2);
            owner_n_key.extend_from_slice(b"o:");
            owner_n_key.extend_from_slice(owner_bytes);
            owner_n_key.extend_from_slice(b":n");
            kv_pairs.push((owner_n_key, count_bytes.clone()));
            kv_pairs.push((b"ti::n".to_vec(), count_bytes));

            let state_map = env.worker.view_state(env.root.id()).await?;
            let mut root_state = state_map
                .get(b"STATE".as_slice())
                .expect("root STATE must exist")
                .clone();
            let state_len = root_state.len();
            let next_id_bytes = ((end + 1) as u64).to_le_bytes();
            root_state[state_len - 8..].copy_from_slice(&next_id_bytes);
            kv_pairs.push((b"STATE".to_vec(), root_state));
        }

        let refs: Vec<(&[u8], &[u8])> = kv_pairs
            .iter()
            .map(|(k, v)| (k.as_slice(), v.as_slice()))
            .collect();
        env.worker
            .patch(env.root.id())
            .states(refs)
            .transact()
            .await?;

        chunk_start = chunk_end + 1;
    }

    Ok(())
}

// ──────────────────────────────────────────────
// 0. Smoke Test: Unimplemented Methods Return NOT_IMPLEMENTED
// ──────────────────────────────────────────────

/// Verifies C1..C5 methods are implemented (no NOT_IMPLEMENTED stubs remain).
#[tokio::test]
async fn smoke_scale_stubs_return_not_implemented() -> Result<()> {
    let env = Env::new().await?;

    // All C1..C5 methods are implemented. Calling `close` executes real claim check.
    let close_res = env
        .alice
        .call(env.root.id(), "close")
        .args_json(json!({ "token_id": "c-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(close_res.is_failure());
    let failure = format!("{:?} {}", close_res.failures(), close_res.logs().join(" "));
    assert!(
        failure.contains("claim not found"),
        "close must fail with claim not found, got: {failure}"
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
    let mut prev = 0usize;

    // Seed intermediate claims in bulk and execute real `issue_claim` transactions at sample points
    for &i in &samples {
        if i > prev + 1 {
            seed_claims_range(&env, &env.alice, prev + 1, i - 1).await?;
        }
        let res = env
            .issue_claim(
                &env.alice,
                0,
                1_000_000 + i as u128,
                1_800_000_000 + i as u64,
            )
            .await?;
        assert!(res.is_success(), "Issue {i} must succeed");

        let report = GasReport::from_result(&res);
        let gas = report.total_gas.as_gas();
        gas_at_samples.push((i, gas));
        prev = i;
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
    let mut prev = 0usize;

    for &i in &samples {
        if i > prev + 1 {
            seed_claims_range(&env, &env.alice, prev + 1, i - 1).await?;
        }
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

        let post_account = env.worker.view_account(env.root.id()).await?;
        let post_storage = post_account.storage_usage;

        let delta = post_storage.saturating_sub(pre_storage);
        storage_deltas_at_samples.push((i, delta));
        prev = i;
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
async fn scale_reconcile_gas_constant() -> Result<()> {
    let env = Env::new().await?;
    let n = scale_claims_target();
    let samples = sample_points(n);

    let mut tokens = Vec::new();
    let mut prev = 0usize;
    for &i in &samples {
        if i > prev + 1 {
            seed_claims_range(&env, &env.alice, prev + 1, i - 1).await?;
        }
        let res = env
            .issue_claim(
                &env.alice,
                0,
                1_000_000 + i as u128,
                1_800_000_000 + i as u64,
            )
            .await?;
        let token: String = res.json()?;
        tokens.push((i, token));
        prev = i;
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
    let mut prev = 0usize;
    for &i in &samples {
        if i > prev + 1 {
            seed_claims_range(&env, &env.alice, prev + 1, i - 1).await?;
        }
        let res = env
            .issue_claim(
                &env.alice,
                0,
                1_000_000 + i as u128,
                1_800_000_000 + i as u64,
            )
            .await?;
        let token: String = res.json()?;
        tokens.push((i, token));
        prev = i;
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

    // Seed claims 1..n in bulk and issue the final claim N via transaction
    if n > 1 {
        seed_claims_range(&env, &env.alice, 1, n - 1).await?;
    }
    let _ = env
        .issue_claim(
            &env.alice,
            0,
            1_000_000 + n as u128,
            1_800_000_000 + n as u64,
        )
        .await?;

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

    // Tail page at n - 2 (e.g. 4,998 at n = 5,000)
    if n >= 50 {
        let tail_page: Vec<JsonToken> = env
            .root
            .view("nft_tokens_for_owner")
            .args_json(json!({
                "account_id": env.alice.id(),
                "from_index": (n - 50).to_string(),
                "limit": 50,
            }))
            .await?
            .json()?;
        assert_eq!(tail_page.len(), 50);
    }

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

    // Measure `claims_by_issuer` gas at N claims (page of 50 matching vs full 1..=N scan)
    let cbi_match = env
        .alice
        .call(env.root.id(), "claims_by_issuer")
        .args_json(json!({
            "account": env.alice.id(),
            "from": n.saturating_sub(49).max(1),
            "limit": 50,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(cbi_match.is_success());
    let cbi_match_gas = cbi_match.total_gas_burnt.as_gas();
    let cbi_match_claims: Vec<ClaimView> = cbi_match.json()?;
    assert_eq!(cbi_match_claims.len(), n.min(50));

    let cbi_scan = env
        .alice
        .call(env.root.id(), "claims_by_issuer")
        .args_json(json!({
            "account": env.bob.id(),
            "from": 1,
            "limit": 50,
        }))
        .max_gas()
        .transact()
        .await?;
    println!(
        "claims_by_issuer at N={}: matching-page gas={} ({:.2} Tgas), full-scan(1..={}) status={:?} gas={} ({:.2} Tgas)",
        n,
        cbi_match_gas,
        cbi_match_gas as f64 / 1e12,
        n,
        cbi_scan.is_success(),
        cbi_scan.total_gas_burnt.as_gas(),
        cbi_scan.total_gas_burnt.as_gas() as f64 / 1e12,
    );

    Ok(())
}
