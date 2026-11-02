//! Smoke tests verifying each mock contract and end-to-end wiring through `Env`.

use anyhow::Result;
use near_sdk::json_types::U128;
use near_workspaces::types::NearToken;
use openrail_tests::{Env, DEFAULT_SETTLEMENT_ASSET};
use serde_json::json;

#[tokio::test]
async fn smoke_mock_intents() -> Result<()> {
    let env = Env::new().await?;

    // 1. Uncreated accounts have balance 0 (Blueprint 1.5.9)
    let uncreated_id = "random-uncreated-account.near";
    let bal: U128 = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({
            "account_id": uncreated_id,
            "token_id": DEFAULT_SETTLEMENT_ASSET,
        }))
        .await?
        .json()?;
    assert_eq!(bal.0, 0, "Uncreated account balance must be 0");

    // 2. Test-only mt_mint credits balance
    env.parent
        .call(env.intents.id(), "mt_mint")
        .args_json(json!({
            "account_id": env.alice.id(),
            "token_id": DEFAULT_SETTLEMENT_ASSET,
            "amount": U128(50_000_000),
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let bal_alice: U128 = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({
            "account_id": env.alice.id(),
            "token_id": DEFAULT_SETTLEMENT_ASSET,
        }))
        .await?
        .json()?;
    assert_eq!(bal_alice.0, 50_000_000);

    // 3. Batch balance query
    let other_asset = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
    let batch: Vec<U128> = env
        .intents
        .view("mt_batch_balance_of")
        .args_json(json!({
            "account_id": env.alice.id(),
            "token_ids": [DEFAULT_SETTLEMENT_ASSET, other_asset],
        }))
        .await?
        .json()?;
    assert_eq!(batch.len(), 2);
    assert_eq!(batch[0].0, 50_000_000);
    assert_eq!(batch[1].0, 0);

    // 4. Transfer requires 1 yocto deposit and moves tokens
    env.alice
        .call(env.intents.id(), "mt_transfer")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": DEFAULT_SETTLEMENT_ASSET,
            "amount": U128(20_000_000),
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let bal_alice_after: U128 = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({
            "account_id": env.alice.id(),
            "token_id": DEFAULT_SETTLEMENT_ASSET,
        }))
        .await?
        .json()?;
    let bal_bob_after: U128 = env
        .intents
        .view("mt_balance_of")
        .args_json(json!({
            "account_id": env.bob.id(),
            "token_id": DEFAULT_SETTLEMENT_ASSET,
        }))
        .await?
        .json()?;

    assert_eq!(bal_alice_after.0, 30_000_000);
    assert_eq!(bal_bob_after.0, 20_000_000);

    // 5. Test fund_claim helper and claim_balance query
    let _ = env.fund_claim("c-1", 10_000_000, None).await?;
    let claim_bal = env.claim_balance("c-1", None).await?;
    assert_eq!(claim_bal, 10_000_000);

    Ok(())
}

#[tokio::test]
async fn smoke_mock_signer() -> Result<()> {
    let env = Env::new().await?;

    let req = json!({
        "payload_v2": { "Ecdsa": "00ff" },
        "path": "evm-1",
        "domain_id": 0,
    });

    let res = env
        .alice
        .call(env.signer.id(), "sign")
        .args_json(json!({ "request": req }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;

    assert!(res.is_success());
    let gas_report = env.gas_report(&res);
    assert!(gas_report.total_tgas > 0.0);

    Ok(())
}

#[tokio::test]
async fn smoke_mock_usdc() -> Result<()> {
    let env = Env::new().await?;

    // Check USDC account mint and balance lookup
    let mint_res = env
        .parent
        .call(env.usdc.id(), "mint")
        .args_json(json!({
            "account_id": env.alice.id(),
            "amount": U128(1_000_000_000),
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(mint_res.is_success());

    let bal: U128 = env
        .usdc
        .view("ft_balance_of")
        .args_json(json!({ "account_id": env.alice.id() }))
        .await?
        .json()?;
    assert_eq!(bal.0, 1_000_000_000);

    Ok(())
}

#[tokio::test]
async fn smoke_end_to_end_wiring() -> Result<()> {
    let env = Env::new().await?;

    // Advance blocks helper verification
    env.advance_blocks(5).await?;

    // Call issue stub on root contract - MUST fail with NOT_IMPLEMENTED,
    // which proves the entire fixture is wired and executing real root WASM code.
    let res = env
        .issue_claim(&env.alice, 0, 10_000_000, 1_700_000_000)
        .await?;

    assert!(
        res.is_failure(),
        "Issue call on frozen interface stub must fail with NOT_IMPLEMENTED"
    );

    let logs = res.logs().join("\n");
    let failure_details = format!("{:?}", res.failures());
    assert!(
        logs.contains("NOT_IMPLEMENTED") || failure_details.contains("NOT_IMPLEMENTED"),
        "Failure must be NOT_IMPLEMENTED, got logs: '{logs}', failures: '{failure_details}'"
    );

    let gas = env.gas_report(&res);
    assert!(gas.total_tgas > 0.0, "Gas must be burnt and reported");

    Ok(())
}
