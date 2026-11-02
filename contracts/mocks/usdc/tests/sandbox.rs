//! Sandbox behaviour of the shared NEP-141 USDC mock, from the P0.6b prompt:
//! `ft_transfer`, `ft_transfer_call` + resolve, balances, supply, storage, metadata, 6 decimals,
//! and the test-only `mint`.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

fn manifest_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn build(manifest: &Path, target_name: &str, wasm_name: &str) -> Result<Vec<u8>> {
    let root = manifest_dir().join("../../..").canonicalize()?;
    let target = root.join("target").join(target_name);
    let status = Command::new(env!("CARGO"))
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "--manifest-path",
            manifest.to_str().expect("utf8 path"),
        ])
        .env("CARGO_TARGET_DIR", &target)
        .env("RUSTFLAGS", "--cfg near")
        .status()
        .with_context(|| format!("build {}", manifest.display()))?;
    if !status.success() {
        return Err(anyhow!("build failed: {}", manifest.display()));
    }
    let wasm = target
        .join("wasm32-unknown-unknown/release")
        .join(wasm_name);
    std::fs::read(&wasm).with_context(|| format!("read {}", wasm.display()))
}

fn usdc_wasm() -> Result<Vec<u8>> {
    build(
        &manifest_dir().join("Cargo.toml"),
        "sandbox-mock-usdc",
        "openrail_mock_usdc.wasm",
    )
}

fn receiver_wasm() -> Result<Vec<u8>> {
    build(
        &manifest_dir().join("tests/receiver/Cargo.toml"),
        "sandbox-mock-usdc-receiver",
        "openrail_mock_ft_receiver.wasm",
    )
}

async fn deploy_usdc(worker: &Worker<Sandbox>) -> Result<Contract> {
    worker
        .dev_deploy(&usdc_wasm()?)
        .await
        .context("deploy the USDC mock")
}

async fn deploy_receiver(worker: &Worker<Sandbox>) -> Result<Contract> {
    worker
        .dev_deploy(&receiver_wasm()?)
        .await
        .context("deploy the ft_on_transfer receiver")
}

async fn mint(usdc: &Contract, account: &Account, amount: u128) -> Result<()> {
    usdc.call("mint")
        .args_json(json!({ "account_id": account.id(), "amount": amount.to_string() }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn register(usdc: &Contract, account: &Account) -> Result<()> {
    usdc.call("storage_deposit")
        .args_json(json!({ "account_id": account.id() }))
        .deposit(NearToken::from_millinear(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn balance(usdc: &Contract, account: &Account) -> Result<u128> {
    let value: String = usdc
        .view("ft_balance_of")
        .args_json(json!({ "account_id": account.id() }))
        .await?
        .json()?;
    Ok(value.parse()?)
}

async fn total_supply(usdc: &Contract) -> Result<u128> {
    let value: String = usdc.view("ft_total_supply").await?.json()?;
    Ok(value.parse()?)
}

#[tokio::test]
async fn metadata_storage_and_mint() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let usdc = deploy_usdc(&worker).await?;
    let alice = worker.dev_create_account().await?;

    let metadata: Value = usdc.view("ft_metadata").await?.json()?;
    assert_eq!(metadata["spec"], "ft-1.0.0");
    assert_eq!(metadata["symbol"], "USDC");
    assert_eq!(metadata["decimals"], 6);

    let before: Option<Value> = usdc
        .view("storage_balance_of")
        .args_json(json!({ "account_id": alice.id() }))
        .await?
        .json()?;
    assert!(before.is_none(), "an unknown account has no storage");

    register(&usdc, &alice).await?;
    let after: Option<Value> = usdc
        .view("storage_balance_of")
        .args_json(json!({ "account_id": alice.id() }))
        .await?
        .json()?;
    assert!(after.is_some(), "storage_deposit registers the account");

    mint(&usdc, &alice, 1_000_000).await?;
    assert_eq!(balance(&usdc, &alice).await?, 1_000_000);
    assert_eq!(total_supply(&usdc).await?, 1_000_000);
    mint(&usdc, &alice, 500).await?;
    assert_eq!(total_supply(&usdc).await?, 1_000_500);
    Ok(())
}

#[tokio::test]
async fn ft_transfer_rules() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let usdc = deploy_usdc(&worker).await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    mint(&usdc, &alice, 1000).await?;

    let no_yocto = alice
        .call(usdc.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": bob.id(), "amount": "400" }))
        .transact()
        .await?;
    assert!(no_yocto.is_failure(), "ft_transfer needs exactly 1 yocto");

    let unregistered = alice
        .call(usdc.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": bob.id(), "amount": "400" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(
        unregistered.is_failure(),
        "the receiver must be registered first"
    );

    register(&usdc, &bob).await?;
    alice
        .call(usdc.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": bob.id(), "amount": "400", "memo": "test" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    assert_eq!(balance(&usdc, &alice).await?, 600);
    assert_eq!(balance(&usdc, &bob).await?, 400);
    assert_eq!(total_supply(&usdc).await?, 1000);

    let too_much = alice
        .call(usdc.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": bob.id(), "amount": "1000" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(too_much.is_failure(), "insufficient balance must fail");
    Ok(())
}

#[tokio::test]
async fn ft_transfer_call_uses_and_refunds() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let usdc = deploy_usdc(&worker).await?;
    let receiver = deploy_receiver(&worker).await?;
    let alice = worker.dev_create_account().await?;
    mint(&usdc, &alice, 1000).await?;
    register(&usdc, &receiver.as_account().clone()).await?;

    alice
        .call(usdc.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": receiver.id(),
            "amount": "300",
            "memo": null,
            "msg": "keep",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(balance(&usdc, &alice).await?, 700);
    assert_eq!(balance(&usdc, &receiver.as_account().clone()).await?, 300);

    alice
        .call(usdc.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": receiver.id(),
            "amount": "200",
            "memo": null,
            "msg": "refund",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        balance(&usdc, &alice).await?,
        700,
        "unused tokens are refunded to the sender"
    );
    assert_eq!(balance(&usdc, &receiver.as_account().clone()).await?, 300);
    assert_eq!(total_supply(&usdc).await?, 1000);
    Ok(())
}
