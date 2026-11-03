//! Dedicated stack sandbox daemon for I1 E2E stack testing.
//!
//! Starts the local NEAR sandbox through `Env`, deploys openrail and mocks,
//! grants restricted function-call keys for the issuer and watcher, funds
//! storage credit for the test business, and outputs connection configuration
//! as a single JSON line to stdout.

use anyhow::{Context, Result};
use near_workspaces::network::NetworkInfo;
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use near_workspaces::Account;
use openrail_tests::Env;
use serde_json::json;
use std::io::Write;

async fn add_function_key(
    account: &Account,
    public_key: near_workspaces::types::PublicKey,
    methods: &[&str],
    root: &near_workspaces::AccountId,
    allowance: NearToken,
) -> Result<()> {
    account
        .batch(account.id())
        .add_key(
            public_key,
            AccessKey::function_call_access(root, methods, Some(allowance)),
        )
        .transact()
        .await?
        .into_result()
        .context("add function-call key")?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let env = Env::new().await.context("start sandbox env")?;
    let rpc_url = env.worker.info().rpc_url.to_string();
    let root = env.root.id().clone();
    let issuer_key = SecretKey::from_seed(KeyType::ED25519, "stack-issuer");
    let relay_key = SecretKey::from_seed(KeyType::ED25519, "stack-relay");
    let watcher_key = SecretKey::from_seed(KeyType::ED25519, "stack-watcher");

    // 1. Grant issuer function keys
    add_function_key(
        &env.issuer,
        issuer_key.public_key(),
        &["issue_for", "log_quote"],
        &root,
        NearToken::from_near(5),
    )
    .await?;

    add_function_key(
        &env.issuer,
        relay_key.public_key(),
        &["acknowledge_evm"],
        &root,
        NearToken::from_millinear(500),
    )
    .await?;

    // 2. Grant watcher function keys
    add_function_key(
        &env.watcher,
        watcher_key.public_key(),
        &["reconcile", "retry_distribution", "clear_stale_lock"],
        &root,
        NearToken::from_near(5),
    )
    .await?;

    // 3. Fund storage credit for alice so issuance succeeds out of the box
    env.alice
        .call(&root, "deposit_storage_credit")
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .context("deposit storage credit for alice")?;

    // 4. Output configuration JSON to stdout
    let payload = json!({
        "rpcUrl": rpc_url,
        "rootAccount": root.to_string(),
        "issuerAccountId": env.issuer.id().to_string(),
        "issuerPrivateKey": issuer_key.to_string(),
        "relayPrivateKey": relay_key.to_string(),
        "watcherAccountId": env.watcher.id().to_string(),
        "watcherPrivateKey": watcher_key.to_string(),
        "aliceAccountId": env.alice.id().to_string(),
        "bobAccountId": env.bob.id().to_string(),
        "intentsAccountId": env.intents.id().to_string(),
        "usdcAccountId": env.usdc.id().to_string(),
    });

    println!("{}", serde_json::to_string(&payload)?);
    println!("__STACK_SANDBOX_READY__");
    std::io::stdout().flush()?;

    // Keep running until SIGTERM or SIGINT
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = sigterm.recv() => {},
    }

    Ok(())
}
