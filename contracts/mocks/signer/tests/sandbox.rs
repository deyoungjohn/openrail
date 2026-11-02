//! Sandbox behaviour of the shared `v1.signer` mock, from the P0.6b prompt and the K15
//! evidence shapes (Ecdsa: Secp256k1/big_r/s/recovery_id; Eddsa: Ed25519/signature[64]).

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Contract, Worker};
use serde_json::{json, Value};

fn manifest_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn build_wasm() -> Result<Vec<u8>> {
    let manifest = manifest_dir();
    let root = manifest.join("../../..").canonicalize()?;
    let target = root.join("target/sandbox-mock-signer");
    let status = Command::new(env!("CARGO"))
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "--manifest-path",
            manifest.join("Cargo.toml").to_str().expect("utf8 path"),
        ])
        .env("CARGO_TARGET_DIR", &target)
        .env("RUSTFLAGS", "--cfg near")
        .status()
        .context("build the signer mock")?;
    if !status.success() {
        return Err(anyhow!("signer mock build failed: {status}"));
    }
    let wasm = target.join("wasm32-unknown-unknown/release/openrail_mock_signer.wasm");
    std::fs::read(&wasm).with_context(|| format!("read {}", wasm.display()))
}

async fn deploy(worker: &Worker<Sandbox>) -> Result<Contract> {
    worker
        .dev_deploy(&build_wasm()?)
        .await
        .context("deploy the signer mock")
}

const ECDSA_HEX: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const ED25519_HEX: &str = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

fn ecdsa_request() -> Value {
    json!({
        "request": {
            "payload_v2": { "Ecdsa": ECDSA_HEX },
            "path": "evm-1",
            "domain_id": 0,
        }
    })
}

fn eddsa_request() -> Value {
    json!({
        "request": {
            "payload_v2": { "Eddsa": ED25519_HEX },
            "path": "sol-1",
            "domain_id": 1,
        }
    })
}

async fn sign(contract: &Contract, args: Value, gas: u64) -> Result<Value> {
    Ok(contract
        .call("sign")
        .args_json(args)
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(gas))
        .transact()
        .await?
        .json()?)
}

#[tokio::test]
async fn sign_returns_k15_ecdsa_shape_and_records_requests() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy(&worker).await?;

    let first = sign(&contract, ecdsa_request(), 100).await?;
    assert_eq!(first["scheme"], "Secp256k1");
    let point = first["big_r"]["affine_point"]
        .as_str()
        .expect("affine_point string");
    assert_eq!(point.len(), 66, "compressed secp256k1 point is 33 bytes");
    assert!(point.starts_with("02"), "compressed point prefix");
    assert_eq!(
        first["s"]["scalar"].as_str().expect("scalar string").len(),
        64,
        "scalar is 32 bytes of hex"
    );
    assert_eq!(first["recovery_id"], 1);

    // Deterministic: the same payload gives the same fake signature.
    let again = sign(&contract, ecdsa_request(), 100).await?;
    assert_eq!(first, again);

    let requests: Vec<Value> = contract.view("signed_requests").await?.json()?;
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0], ecdsa_request()["request"]);
    Ok(())
}

#[tokio::test]
async fn sign_returns_k15_eddsa_shape() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy(&worker).await?;

    let first = sign(&contract, eddsa_request(), 100).await?;
    assert_eq!(first["scheme"], "Ed25519");
    let signature = first["signature"].as_array().expect("signature array");
    assert_eq!(signature.len(), 64);
    assert!(signature.iter().all(|byte| byte.as_u64().unwrap() <= 255));
    assert_eq!(first, sign(&contract, eddsa_request(), 100).await?);
    Ok(())
}

#[tokio::test]
async fn sign_rejects_unknown_payload_and_missing_fields() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy(&worker).await?;

    let unknown = json!({
        "request": { "payload_v2": { "Bls": "00" }, "path": "evm-1", "domain_id": 0 }
    });
    let res = contract
        .call("sign")
        .args_json(unknown)
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_failure(), "unknown payload must be refused");

    let missing = json!({ "request": { "payload_v2": { "Ecdsa": ECDSA_HEX } } });
    let res = contract
        .call("sign")
        .args_json(missing)
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_failure(), "path and domain_id are required");
    Ok(())
}

#[tokio::test]
async fn sign_requires_exactly_one_yocto() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy(&worker).await?;

    for deposit in [0u128, 2] {
        let res = contract
            .call("sign")
            .args_json(ecdsa_request())
            .deposit(NearToken::from_yoctonear(deposit))
            .max_gas()
            .transact()
            .await?;
        assert!(
            res.is_failure(),
            "sign with a {deposit}-yocto deposit must fail"
        );
    }
    assert!(sign(&contract, ecdsa_request(), 100).await.is_ok());
    Ok(())
}

#[tokio::test]
async fn sign_controls_fail_and_min_gas() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy(&worker).await?;

    contract
        .call("set_min_gas_tgas")
        .args_json(json!({ "min_tgas": 100 }))
        .transact()
        .await?
        .into_result()?;

    let low = contract
        .call("sign")
        .args_json(ecdsa_request())
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    assert!(low.is_failure(), "signer must refuse below the gas floor");
    assert!(
        sign(&contract, ecdsa_request(), 150).await.is_ok(),
        "sign must pass at or above the gas floor"
    );

    contract
        .call("set_fail")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    let failed = contract
        .call("sign")
        .args_json(ecdsa_request())
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(failed.is_failure(), "set_fail(true) must make sign fail");

    contract
        .call("set_fail")
        .args_json(json!({ "fail": false }))
        .transact()
        .await?
        .into_result()?;
    assert!(sign(&contract, ecdsa_request(), 100).await.is_ok());
    Ok(())
}
