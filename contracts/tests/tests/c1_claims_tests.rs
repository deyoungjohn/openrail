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

    // Measure storage usage before issue
    let root_acc_before = env.root.view_account().await?;
    let storage_before = root_acc_before.storage_usage;

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

    // Measure storage usage after issue
    let root_acc_after = env.root.view_account().await?;
    let storage_after = root_acc_after.storage_usage;
    let storage_diff = storage_after.saturating_sub(storage_before);
    println!("Claim c-1 on-chain root storage consumption: {storage_diff} bytes");
    assert!(storage_diff > 0, "storage usage must increase");

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
    assert!(cv.kind_rules.ack_required_for_sale);
    assert!(cv.kind_rules.sellable);
    assert_eq!(cv.kind_rules.quote_deadline, 3600);
    assert!(!cv.kind_rules.debtor_optional);

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

    // First configure alice as a quote writer
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

/// Finding 1: Tests that failed claim subaccount creation deletes the claim record,
/// refunds the attached deposit to the payer (or restores credit for issue_for),
/// and completes normally without panicking.
#[tokio::test]
async fn test_c1_issue_failure_refunds_and_deletes_claim() -> Result<()> {
    let env = Env::new().await?;

    // Configure vault_code_hash to an unknown / invalid hash
    let invalid_hash = Hex32::new([99u8; 32]);
    let cfg_res = env
        .root
        .call("set_config")
        .args_json(json!({
            "vault_code_hash": invalid_hash,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(cfg_res.is_success());

    // 1. Direct `issue` with attached deposit (50 mN)
    let alice_bal_before = env.alice.view_account().await?.balance;
    let res = env
        .issue_claim(&env.alice, 0, 10_000_000, 1_700_000_000)
        .await?;

    // Transaction executes without callback panic reverting state
    assert!(res.is_success(), "Transaction must succeed without panic");

    // Must NOT emit nft_mint on failed account creation (Mutant 5 verification)
    let events = openrail_tests::decode_events(&res);
    let mint_events: Vec<_> = events
        .into_iter()
        .filter(|e| e.get("event").and_then(|v| v.as_str()) == Some("nft_mint"))
        .collect();
    assert!(
        mint_events.is_empty(),
        "Must NOT emit nft_mint on failed account creation"
    );

    // Claim must be deleted from state
    let claim_view: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert!(claim_view.is_none(), "Claim c-1 must not exist in state");

    // Payer's attached deposit was refunded (balance decreased only by gas, not 0.05 NEAR)
    let alice_bal_after = env.alice.view_account().await?.balance;
    let diff = alice_bal_before
        .as_yoctonear()
        .saturating_sub(alice_bal_after.as_yoctonear());
    assert!(
        diff < NearToken::from_millinear(10).as_yoctonear(),
        "Payer must receive full deposit refund, diff was {} yocto",
        diff
    );

    // 2. `issue_for` failure: storage credit must be restored
    // Deposit 50 mN storage credit for bob
    env.bob
        .call(env.root.id(), "deposit_storage_credit")
        .deposit(NearToken::from_millinear(50))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let res_for = env
        .issuer
        .call(env.root.id(), "issue_for")
        .args_json(json!({
            "business": env.bob.id(),
            "kind": 0,
            "debtor": Debtor::Near(env.alice.id().clone()),
            "terms_hash": Hex32::new([123u8; 32]),
            "amount_due": U128(10_000_000),
            "due_date": 1_700_000_000u64,
            "metadata": null,
        }))
        .max_gas()
        .transact()
        .await?;

    assert!(res_for.is_success());

    // Claim c-2 must not exist
    let claim2: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-2" }))
        .await?
        .json()?;
    assert!(claim2.is_none(), "Claim c-2 must not exist in state");

    // Bob can withdraw all 50 mN credit, proving it was fully restored upon failure
    let withdraw_res = env
        .bob
        .call(env.root.id(), "withdraw_storage_credit")
        .args_json(json!({
            "amount": U128(NearToken::from_millinear(50).as_yoctonear())
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(
        withdraw_res.is_success(),
        "Credit was restored and full amount can be withdrawn"
    );

    Ok(())
}

/// Mutation Break 1: Issuance when issue_paused is true is rejected.
#[tokio::test]
async fn test_c1_mutation_break_1_issue_paused() -> Result<()> {
    let env = Env::new().await?;

    let pause_res = env
        .root
        .call("pause_issue")
        .args_json(json!({ "paused": true }))
        .max_gas()
        .transact()
        .await?;
    assert!(pause_res.is_success());

    let res = env
        .issue_claim(&env.alice, 0, 10_000_000, 1_700_000_000)
        .await?;
    assert!(res.is_failure());
    let failure = format!("{:?}", res.failures());
    assert!(
        failure.contains("issuance is paused"),
        "Must reject with 'issuance is paused', got: {failure}"
    );

    Ok(())
}

/// Mutation Break 2: issue_for rejected when storage_credit is insufficient.
#[tokio::test]
async fn test_c1_mutation_break_2_no_storage_credit() -> Result<()> {
    let env = Env::new().await?;

    let res = env
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
    assert!(res.is_failure());
    let failure = format!("{:?}", res.failures());
    assert!(
        failure.contains("NO_STORAGE_CREDIT"),
        "Must reject with 'NO_STORAGE_CREDIT', got: {failure}"
    );

    Ok(())
}

/// Mutation Break 3: issue_for rejected from unauthorized caller (not in config.issuers).
#[tokio::test]
async fn test_c1_mutation_break_3_unauthorized_issuer() -> Result<()> {
    let env = Env::new().await?;

    let res = env
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
    assert!(res.is_failure());
    let failure = format!("{:?}", res.failures());
    assert!(
        failure.contains("Unauthorized issuer"),
        "Must reject with 'Unauthorized issuer', got: {failure}"
    );

    Ok(())
}

/// Mutation Break 4: duplicate quote_id rejected on the same token.
#[tokio::test]
async fn test_c1_mutation_break_4_duplicate_quote_id() -> Result<()> {
    let env = Env::new().await?;

    let issue_ok = env
        .issue_claim(&env.alice, 0, 10_000_000, 1_700_000_000)
        .await?;
    assert!(issue_ok.is_success());

    // Authorize alice as quote writer
    env.root
        .call("set_config")
        .args_json(json!({
            "quote_writers": [env.alice.id()],
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let quote = Quote {
        quote_id: "mut-quote-dup".to_string(),
        deposit_address: "0x123".to_string(),
        deadline_requested: 1_700_003_600,
        refund_to: "alice.near".to_string(),
        route_id: "ethereum-usdc".to_string(),
    };

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

    // Duplicate quote_id must fail
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

/// Mutation Break 5: log_quote rejected from unauthorized caller (not in config.quote_writers).
#[tokio::test]
async fn test_c1_mutation_break_5_unauthorized_quote_writer() -> Result<()> {
    let env = Env::new().await?;

    let issue_ok = env
        .issue_claim(&env.alice, 0, 10_000_000, 1_700_000_000)
        .await?;
    assert!(issue_ok.is_success());

    let quote = Quote {
        quote_id: "mut-quote-unauth".to_string(),
        deposit_address: "0x123".to_string(),
        deadline_requested: 1_700_003_600,
        refund_to: "alice.near".to_string(),
        route_id: "ethereum-usdc".to_string(),
    };

    let res = env
        .alice
        .call(env.root.id(), "log_quote")
        .args_json(json!({
            "token_id": "c-1",
            "quote": quote,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_failure());
    let failure = format!("{:?}", res.failures());
    assert!(
        failure.contains("Unauthorized quote writer"),
        "Must reject with 'Unauthorized quote writer', got: {failure}"
    );

    Ok(())
}

/// Mutation Break 6: issue rejected when vault_code_hash is not configured.
#[tokio::test]
async fn test_c1_mutation_break_6_vault_not_configured() -> Result<()> {
    let env = Env::new().await?;

    // Zero out vault_code_hash
    env.root
        .call("set_config")
        .args_json(json!({
            "vault_code_hash": Hex32::new([0u8; 32]),
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let res = env
        .issue_claim(&env.alice, 0, 10_000_000, 1_700_000_000)
        .await?;
    assert!(res.is_failure());
    let failure = format!("{:?}", res.failures());
    assert!(
        failure.contains("vault not configured"),
        "Must reject with 'vault not configured', got: {failure}"
    );

    Ok(())
}

/// Excess deposit refund verification (Mutant 4):
/// Asserts that when a caller attaches more than REQUIRED_ISSUE_DEPOSIT (e.g. 1 NEAR),
/// the excess (~0.95 NEAR) is refunded back to the caller in `on_issue`.
#[tokio::test]
async fn test_c1_excess_deposit_refunded() -> Result<()> {
    let env = Env::new().await?;

    let alice_bal_before = env.alice.view_account().await?.balance;

    let res = env
        .alice
        .call(env.root.id(), "issue")
        .args_json(json!({
            "kind": 0,
            "debtor": Debtor::Near(env.bob.id().clone()),
            "terms_hash": Hex32::new([42u8; 32]),
            "amount_due": U128(10_000_000),
            "due_date": 1_700_000_000u64,
            "metadata": null,
        }))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?;

    assert!(res.is_success(), "issue must succeed");

    let alice_bal_after = env.alice.view_account().await?.balance;
    let diff = alice_bal_before
        .as_yoctonear()
        .saturating_sub(alice_bal_after.as_yoctonear());

    // Alice should only have spent ~0.05 NEAR storage + minimal gas, NOT 1.0 NEAR.
    assert!(
        diff < NearToken::from_millinear(65).as_yoctonear(),
        "Excess deposit must be refunded: diff was {} yocto (>= 0.065 NEAR)",
        diff
    );

    Ok(())
}
