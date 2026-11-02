//! Tests for Phase 1 Work Package C1: Claim Storage, Issuance, Storage Credits, and Views.
//!
//! Blueprint references: 2.1, 2.2, 1.5.4, 1.5.6, 1.5.9, 3.1.4.

use anyhow::Result;
use near_sdk::json_types::U128;
use near_workspaces::types::NearToken;
use openrail::types::{ClaimView, Config, Debtor, Hex32, Quote, Status};
use openrail_tests::Env;
use serde_json::json;

#[tokio::test]
async fn test_c1_issue_lifecycle_and_views() -> Result<()> {
    let env = Env::new().await?;

    let terms_hash = Hex32::new([77u8; 32]);
    let amount_due = 10_000_000u128; // 10 USDC
    let due_date = 1_800_000_000u64;

    // Issue claim as alice
    let res = env
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

    assert!(res.is_success(), "issue must succeed");
    let token_id: String = res.clone().json()?;
    assert_eq!(token_id, "c-1");

    // Events emitted: nft_mint and issue
    let mint_events = env.assert_event(&res, "nft_mint");
    assert_eq!(mint_events.len(), 1);
    let issue_events = env.assert_event(&res, "issue");
    assert_eq!(issue_events.len(), 1);

    // View: claim
    let claim_view: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert!(claim_view.is_some());
    let cv = claim_view.unwrap();
    assert_eq!(cv.token_id, "c-1");
    assert_eq!(cv.kind, 0);
    assert_eq!(cv.issuer_id, env.alice.id().clone());
    assert_eq!(cv.owner_id, env.alice.id().clone());
    assert_eq!(cv.amount_due.0, amount_due);
    assert_eq!(cv.status, Status::Issued);
    assert_eq!(cv.booked_total.0, 0);
    assert_eq!(cv.surplus.0, 0);
    assert_eq!(cv.credit_total.0, 0);

    // View: outstanding
    let outstanding: Option<U128> = env
        .root
        .view("outstanding")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert_eq!(outstanding, Some(U128(amount_due)));

    // View: claims_by_issuer
    let alice_claims: Vec<ClaimView> = env
        .root
        .view("claims_by_issuer")
        .args_json(json!({ "account": env.alice.id() }))
        .await?
        .json()?;
    assert_eq!(alice_claims.len(), 1);
    assert_eq!(alice_claims[0].token_id, "c-1");

    // View: config
    let config: Config = env.root.view("config").args_json(json!({})).await?.json()?;
    assert!(!config.issue_paused);
    assert_eq!(config.settlement_assets.len(), 4);

    Ok(())
}

#[tokio::test]
async fn test_c1_storage_credits_and_issue_for() -> Result<()> {
    let env = Env::new().await?;

    // 1. Deposit storage credit from bob (business)
    let deposit_amount = NearToken::from_millinear(50); // 0.05 NEAR
    env.bob
        .call(env.root.id(), "deposit_storage_credit")
        .deposit(deposit_amount)
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // 2. Call issue_for from allow-listed issuer account (env.issuer)
    let terms_hash = Hex32::new([88u8; 32]);
    let amount_due = 25_000_000u128;
    let due_date = 1_850_000_000u64;

    let res = env
        .issuer
        .call(env.root.id(), "issue_for")
        .args_json(json!({
            "business": env.bob.id(),
            "kind": 0,
            "debtor": Debtor::Near(env.alice.id().clone()),
            "terms_hash": terms_hash,
            "amount_due": U128(amount_due),
            "due_date": due_date,
            "metadata": null,
        }))
        .max_gas()
        .transact()
        .await?;

    assert!(res.is_success(), "issue_for must succeed");
    let token_id: String = res.clone().json()?;
    assert_eq!(token_id, "c-1");

    // Verify claim belongs to bob
    let cv: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json::<Option<ClaimView>>()?
        .expect("claim c-1 must exist");
    assert_eq!(cv.owner_id, env.bob.id().clone());
    assert_eq!(cv.issuer_id, env.bob.id().clone());

    // 3. Withdraw remaining storage credit (50 mN - 20 mN = 30 mN)
    let withdraw_res = env
        .bob
        .call(env.root.id(), "withdraw_storage_credit")
        .args_json(json!({
            "amount": U128(NearToken::from_millinear(30).as_yoctonear())
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(withdraw_res.is_success());

    Ok(())
}

#[tokio::test]
async fn test_c1_payment_log_and_quotes() -> Result<()> {
    let env = Env::new().await?;

    // Issue a claim first
    let res = env
        .issue_claim(&env.alice, 0, 10_000_000, 1_700_000_000)
        .await?;
    assert!(res.is_success());

    let quote1 = Quote {
        quote_id: "quote-alpha".to_string(),
        deposit_address: "0x1111111111111111111111111111111111111111".to_string(),
        deadline_requested: 1_700_003_600,
        refund_to: "alice.near".to_string(),
        route_id: "ethereum-usdc".to_string(),
    };

    // Log quote from allow-listed quote_writer (we can use env.root or an allow-listed writer)
    // First, let's configure alice as a quote writer or use the root to set quote_writers
    let set_cfg_res = env
        .root
        .call("set_config")
        .args_json(json!({
            "quote_writers": [env.alice.id()],
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(set_cfg_res.is_success());

    // alice logs quote
    let log_res = env
        .alice
        .call(env.root.id(), "log_quote")
        .args_json(json!({
            "token_id": "c-1",
            "quote": quote1,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(log_res.is_success());

    // Query payment_log view
    let log_entries: Vec<Quote> = env
        .root
        .view("payment_log")
        .args_json(json!({
            "token_id": "c-1",
        }))
        .await?
        .json()?;
    assert_eq!(log_entries.len(), 1);
    assert_eq!(log_entries[0].quote_id, "quote-alpha");

    Ok(())
}

#[tokio::test]
async fn test_c1_mutation_5_breaks() -> Result<()> {
    let env = Env::new().await?;

    // Break 1: Issue paused rejected
    let pause_res = env
        .root
        .call("pause_issue")
        .args_json(json!({ "paused": true }))
        .max_gas()
        .transact()
        .await?;
    assert!(pause_res.is_success());

    let break1_res = env
        .issue_claim(&env.alice, 0, 10_000_000, 1_700_000_000)
        .await?;
    assert!(break1_res.is_failure());
    let failure1 = format!("{:?}", break1_res.failures());
    assert!(
        failure1.contains("issuance is paused"),
        "Must reject with 'issuance is paused', got: {failure1}"
    );

    // Unpause for subsequent tests
    env.root
        .call("pause_issue")
        .args_json(json!({ "paused": false }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Break 2: issue_for rejected when NO_STORAGE_CREDIT
    let break2_res = env
        .issuer
        .call(env.root.id(), "issue_for")
        .args_json(json!({
            "business": env.bob.id(),
            "kind": 0,
            "debtor": Debtor::Near(env.alice.id().clone()),
            "terms_hash": Hex32::new([1u8; 32]),
            "amount_due": U128(10_000_000),
            "due_date": 1_700_000_000u64,
            "metadata": null,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(break2_res.is_failure());
    let failure2 = format!("{:?}", break2_res.failures());
    assert!(
        failure2.contains("NO_STORAGE_CREDIT"),
        "Must reject with 'NO_STORAGE_CREDIT', got: {failure2}"
    );

    // Break 3: issue_for from unauthorized issuer rejected
    let break3_res = env
        .alice
        .call(env.root.id(), "issue_for")
        .args_json(json!({
            "business": env.bob.id(),
            "kind": 0,
            "debtor": Debtor::Near(env.bob.id().clone()),
            "terms_hash": Hex32::new([1u8; 32]),
            "amount_due": U128(10_000_000),
            "due_date": 1_700_000_000u64,
            "metadata": null,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(break3_res.is_failure());
    let failure3 = format!("{:?}", break3_res.failures());
    assert!(
        failure3.contains("Unauthorized issuer"),
        "Must reject with 'Unauthorized issuer', got: {failure3}"
    );

    // Create a claim for break 4 and 5
    let issue_ok = env
        .issue_claim(&env.alice, 0, 10_000_000, 1_700_000_000)
        .await?;
    assert!(issue_ok.is_success());

    // Break 5 (test before break 4): log_quote by unauthorized caller rejected
    let quote = Quote {
        quote_id: "mut-quote-1".to_string(),
        deposit_address: "0x123".to_string(),
        deadline_requested: 1_700_003_600,
        refund_to: "alice.near".to_string(),
        route_id: "ethereum-usdc".to_string(),
    };
    let break5_res = env
        .alice
        .call(env.root.id(), "log_quote")
        .args_json(json!({
            "token_id": "c-1",
            "quote": quote,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(break5_res.is_failure());
    let failure5 = format!("{:?}", break5_res.failures());
    assert!(
        failure5.contains("Unauthorized quote writer"),
        "Must reject with 'Unauthorized quote writer', got: {failure5}"
    );

    // Now authorize alice as quote writer and log quote once
    env.root
        .call("set_config")
        .args_json(json!({
            "quote_writers": [env.alice.id()],
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    env.alice
        .call(env.root.id(), "log_quote")
        .args_json(json!({
            "token_id": "c-1",
            "quote": quote,
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Break 4: duplicate quote_id rejected
    let break4_res = env
        .alice
        .call(env.root.id(), "log_quote")
        .args_json(json!({
            "token_id": "c-1",
            "quote": quote,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(break4_res.is_failure());
    let failure4 = format!("{:?}", break4_res.failures());
    assert!(
        failure4.contains("duplicate quote_id"),
        "Must reject with 'duplicate quote_id', got: {failure4}"
    );

    Ok(())
}
