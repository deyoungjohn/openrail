//! Sandbox suite for vault v2, written from blueprint §1.5.3 and the vault bullets of §2.11.
//!
//! The fixture is local to this crate: one mock wasm that can publish the vault as a global
//! contract, create keyless accounts that run it by hash, receive `mt_transfer` and receive
//! `sign`. The shared P0.6 harness will replace it later.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountDetailsPatch, AccountId, Contract, ContractState, Worker};
use serde_json::{json, Value};

const FORWARD_MIN_TGAS: u64 = 8;
const FORWARD_MAX_TGAS: u64 = 50;
const SIGN_MAX_TGAS: u64 = 280;

/// One sandbox at a time: ten neard processes on a 2-core CI runner is needless load.
static SANDBOX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Fixture {
    worker: Worker<Sandbox>,
    /// The parent account: the account that owns the keyless vault accounts.
    parent: Account,
    /// The mock deployed on `intents.near` (records `mt_transfer`).
    intents: Contract,
    /// The mock deployed on `v1.signer` (records `sign`).
    signer: Contract,
    invoice_id: AccountId,
    vault_hash: String,
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("workspace root")
}

/// Builds the vault for the sandbox. Prefers `cargo near build` output when it is fresh,
/// otherwise compiles the same source with `--cfg near` into a private target dir.
fn vault_wasm() -> Result<Vec<u8>> {
    if let Ok(path) = std::env::var("VAULT_WASM") {
        return std::fs::read(&path).with_context(|| format!("read VAULT_WASM={path}"));
    }

    let root = workspace_root();
    let target = root.join("target/sandbox-vault");
    let is_newer_than = |wasm: &Path| -> bool {
        let built = wasm.metadata().and_then(|m| m.modified()).ok();
        let src = root
            .join("contracts/vault/src/lib.rs")
            .metadata()
            .and_then(|m| m.modified())
            .ok();
        match (built, src) {
            (Some(built), Some(src)) => built >= src,
            _ => false,
        }
    };

    let near_wasm = root.join("target/near/openrail_vault/openrail_vault.wasm");
    if near_wasm.exists() && is_newer_than(&near_wasm) {
        return std::fs::read(&near_wasm).context("read cargo-near vault wasm");
    }

    let status = Command::new(env!("CARGO"))
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "--manifest-path",
            root.join("contracts/vault/Cargo.toml")
                .to_str()
                .expect("utf8 path"),
        ])
        .env("CARGO_TARGET_DIR", &target)
        .env("RUSTFLAGS", "--cfg near")
        .status()
        .context("run cargo build for the vault")?;
    if !status.success() {
        return Err(anyhow!("vault build failed: {status}"));
    }
    let wasm = target.join("wasm32-unknown-unknown/release/openrail_vault.wasm");
    std::fs::read(&wasm).with_context(|| format!("read {}", wasm.display()))
}

fn mock_wasm() -> Result<Vec<u8>> {
    let root = workspace_root();
    let target = root.join("target/sandbox-mock");
    let manifest = root.join("contracts/vault/tests/mocks/Cargo.toml");
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
        .context("run cargo build for the test mock")?;
    if !status.success() {
        return Err(anyhow!("mock build failed: {status}"));
    }
    let wasm = target.join("wasm32-unknown-unknown/release/openrail_vault_mock.wasm");
    std::fs::read(&wasm).with_context(|| format!("read {}", wasm.display()))
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        out.push(ALPHABET[(b[0] >> 2) as usize] as char);
        out.push(ALPHABET[(((b[0] & 0b11) << 4) | (b[1] >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(((b[1] & 0b1111) << 2) | (b[2] >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(b[2] & 0b111111) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn seeded(id: &str) -> SecretKey {
    SecretKey::from_seed(KeyType::ED25519, id)
}

/// Puts the mock at a fixed account id (`intents.near`, `v1.signer`).
/// Those names are reserved (only `near`/`v1` may create them), so the sandbox state is patched
/// instead of creating a subaccount. The vault only calls these accounts; it never signs for them.
async fn create_mock_account(worker: &Worker<Sandbox>, id: &str, wasm: &[u8]) -> Result<Contract> {
    let account_id: AccountId = id.parse()?;
    worker
        .patch(&account_id)
        .account(AccountDetailsPatch::default().balance(NearToken::from_near(100)))
        .code(wasm)
        .transact()
        .await
        .with_context(|| format!("patch mock at {id}"))?;
    Ok(Contract::from_secret_key(account_id, seeded(id), worker))
}

async fn create_invoice(
    worker: &Worker<Sandbox>,
    helper: &Contract,
    prefix: &str,
    n: u64,
    parent: &str,
) -> Result<AccountId> {
    let id: AccountId = format!("{prefix}-{n}.{parent}").parse()?;
    let mut last = None;
    for _ in 0..10 {
        let res = helper
            .call("create_keyless")
            .args_json(json!({ "prefix": prefix, "n": n }))
            .max_gas()
            .transact()
            .await?;
        match res.into_result() {
            Ok(_) => {
                worker.view_account(&id).await?;
                return Ok(id);
            }
            Err(err) => {
                // A freshly published global contract is not usable for a few seconds (§1.5.4).
                last = Some(err.to_string());
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
    Err(anyhow!("create {id} failed: {last:?}"))
}

async fn setup() -> Result<Fixture> {
    let worker = near_workspaces::sandbox().await?;
    let parent = worker.root_account()?;
    let vault = vault_wasm()?;
    let mock = mock_wasm()?;

    let helper = parent.deploy(&mock).await?.into_result()?;
    let intents = create_mock_account(&worker, "intents.near", &mock).await?;
    let signer = create_mock_account(&worker, "v1.signer", &mock).await?;

    let vault_hash: String = helper
        .call("publish_vault")
        .args_json(json!({ "code": base64(&vault) }))
        .max_gas()
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .json()
        .context("publish vault as a global contract")?;

    let invoice_id = create_invoice(&worker, &helper, "inv", 1, parent.id().as_str()).await?;

    Ok(Fixture {
        worker,
        parent,
        intents,
        signer,
        invoice_id,
        vault_hash,
    })
}

impl Fixture {
    async fn forward(&self, caller: &Account, gas_tgas: u64) -> Result<Value> {
        Ok(caller
            .call(&self.invoice_id, "forward")
            .args_json(json!({
                "token_id": "nep141:usdc.omft.near",
                "amount": "2500",
                "receiver_id": "payee.near",
                "gas_tgas": gas_tgas,
            }))
            .max_gas()
            .transact()
            .await?
            .json()?)
    }

    async fn forward_res(&self, caller: &Account, gas_tgas: u64) -> Result<ExecutionFinalResult> {
        Ok(caller
            .call(&self.invoice_id, "forward")
            .args_json(json!({
                "token_id": "nep141:usdc.omft.near",
                "amount": "2500",
                "receiver_id": "payee.near",
                "gas_tgas": gas_tgas,
            }))
            .max_gas()
            .transact()
            .await?)
    }

    async fn sign_res(&self, caller: &Account, gas_tgas: u64) -> Result<ExecutionFinalResult> {
        Ok(caller
            .call(&self.invoice_id, "sign")
            .args_json(json!({
                "payload": { "Ecdsa": "00ff" },
                "path": "evm-1",
                "domain_id": 0,
                "gas_tgas": gas_tgas,
            }))
            .max_gas()
            .transact()
            .await?)
    }
}

// --- blueprint invariant names carried from the spike -----------------------

#[tokio::test]
async fn inv_account_has_no_keys() -> Result<()> {
    let _serial = SANDBOX.lock().await;
    let f = setup().await?;
    let keys = f.worker.view_access_keys(&f.invoice_id).await?;
    assert!(
        keys.is_empty(),
        "the vault account must have no access keys, found {:?}",
        keys.iter().map(|k| &k.public_key).collect::<Vec<_>>()
    );
    Ok(())
}

#[tokio::test]
async fn inv_account_obeys_only_owed() -> Result<()> {
    let _serial = SANDBOX.lock().await;
    let f = setup().await?;
    let outsider = f.worker.dev_create_account().await?;

    let res = f.forward_res(&outsider, 12).await?;
    assert!(res.is_failure(), "forward from a non-parent must fail");
    let res = f.sign_res(&outsider, 100).await?;
    assert!(res.is_failure(), "sign from a non-parent must fail");

    // The account that owns the keyless account may call both methods.
    let out = f.forward(&f.parent, 12).await?;
    assert_eq!(out["amount"], "2500");
    let signed = f
        .parent
        .call(&f.invoice_id, "sign")
        .args_json(json!({
            "payload": { "Ecdsa": "00ff" },
            "path": "evm-1",
            "domain_id": 0,
            "gas_tgas": 100,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(signed.is_success(), "sign from the parent must succeed");
    Ok(())
}

#[tokio::test]
async fn only_the_parent_can_call_forward_and_sign() -> Result<()> {
    let _serial = SANDBOX.lock().await;
    let f = setup().await?;
    let other = f.worker.dev_create_account().await?;

    assert!(f.forward_res(&other, 12).await?.is_failure());
    assert!(f.sign_res(&other, 100).await?.is_failure());
    assert!(f.forward_res(&f.parent, 12).await?.is_success());
    assert!(f.sign_res(&f.parent, 100).await?.is_success());
    Ok(())
}

// --- vault v2 bounds ---------------------------------------------------------

#[tokio::test]
async fn forward_gas_bound_is_8_to_50_tgas() -> Result<()> {
    let _serial = SANDBOX.lock().await;
    let f = setup().await?;

    let low = f.forward_res(&f.parent, FORWARD_MIN_TGAS - 1).await?;
    assert!(
        low.is_failure(),
        "forward must refuse {} Tgas",
        FORWARD_MIN_TGAS - 1
    );

    let min = f.forward_res(&f.parent, FORWARD_MIN_TGAS).await?;
    assert!(
        min.is_success(),
        "forward must accept {FORWARD_MIN_TGAS} Tgas: {min:?}"
    );

    let max = f.forward_res(&f.parent, FORWARD_MAX_TGAS).await?;
    assert!(
        max.is_success(),
        "forward must accept {FORWARD_MAX_TGAS} Tgas: {max:?}"
    );

    let high = f.forward_res(&f.parent, FORWARD_MAX_TGAS + 1).await?;
    assert!(
        high.is_failure(),
        "forward must refuse {} Tgas",
        FORWARD_MAX_TGAS + 1
    );
    Ok(())
}

#[tokio::test]
async fn sign_gas_bound_is_at_most_280_tgas() -> Result<()> {
    let _serial = SANDBOX.lock().await;
    let f = setup().await?;

    let max = f.sign_res(&f.parent, SIGN_MAX_TGAS).await?;
    assert!(
        max.is_success(),
        "sign must accept {SIGN_MAX_TGAS} Tgas: {max:?}"
    );

    let high = f.sign_res(&f.parent, SIGN_MAX_TGAS + 1).await?;
    assert!(
        high.is_failure(),
        "sign must refuse {} Tgas",
        SIGN_MAX_TGAS + 1
    );
    Ok(())
}

// --- exactly two methods, no keys, global deployment ------------------------

fn function_exports(wasm: &[u8]) -> Vec<String> {
    fn uleb(bytes: &[u8], mut i: usize) -> (usize, usize) {
        let mut result = 0usize;
        let mut shift = 0usize;
        loop {
            let byte = bytes[i];
            i += 1;
            result |= ((byte & 0x7f) as usize) << shift;
            shift += 7;
            if byte & 0x80 == 0 {
                return (result, i);
            }
        }
    }

    let mut i = 8; // magic + version
    let mut exports = Vec::new();
    while i < wasm.len() {
        let section = wasm[i];
        i += 1;
        let (size, next) = uleb(wasm, i);
        let end = next + size;
        if section == 7 {
            let (count, mut j) = uleb(wasm, next);
            for _ in 0..count {
                let (len, k) = uleb(wasm, j);
                let name = String::from_utf8_lossy(&wasm[k..k + len]).to_string();
                j = k + len;
                let kind = wasm[j];
                j += 1;
                let (_, k) = uleb(wasm, j);
                j = k;
                if kind == 0 {
                    exports.push(name);
                }
            }
        }
        i = end;
    }
    exports.sort();
    exports
}

#[test]
fn exactly_two_public_methods() -> Result<()> {
    let wasm = vault_wasm()?;
    let exports = function_exports(&wasm);
    assert_eq!(
        exports,
        vec!["forward".to_string(), "sign".to_string()],
        "the vault must export exactly forward and sign"
    );
    Ok(())
}

#[tokio::test]
async fn deployed_from_a_global_hash_works() -> Result<()> {
    let _serial = SANDBOX.lock().await;
    let f = setup().await?;

    let details = f.worker.view_account(&f.invoice_id).await?;
    match details.contract_state {
        ContractState::GlobalHash(hash) => assert_eq!(
            hash.to_string(),
            f.vault_hash,
            "the account must point at the published vault hash"
        ),
        other => panic!("the vault account must run code by global hash, got {other:?}"),
    }

    // The code really executes: a parent call reaches the mock receiver.
    let out = f.forward(&f.parent, 12).await?;
    assert_eq!(out["token_id"], "nep141:usdc.omft.near");
    Ok(())
}

#[tokio::test]
async fn no_key_can_be_added() -> Result<()> {
    let _serial = SANDBOX.lock().await;
    let f = setup().await?;

    assert!(f.worker.view_access_keys(&f.invoice_id).await?.is_empty());

    for method in ["add_key", "add_full_access_key", "add_access_key"] {
        let res = f
            .parent
            .call(&f.invoice_id, method)
            .args_json(json!({}))
            .max_gas()
            .transact()
            .await?;
        assert!(res.is_failure(), "the vault must not expose {method}");
    }
    assert!(f.worker.view_access_keys(&f.invoice_id).await?.is_empty());
    Ok(())
}

// --- forwarding and signing semantics --------------------------------------

#[tokio::test]
async fn forward_moves_tokens_through_the_receiver() -> Result<()> {
    let _serial = SANDBOX.lock().await;
    let f = setup().await?;

    let out = f.forward(&f.parent, 12).await?;
    assert_eq!(
        out,
        json!({
            "receiver_id": "payee.near",
            "token_id": "nep141:usdc.omft.near",
            "amount": "2500",
        })
    );

    let last: Option<String> = f.intents.view("last_call").await?.json()?;
    assert!(
        last.expect("intents mock was called")
            .contains("mt_transfer"),
        "forward must call mt_transfer"
    );
    Ok(())
}

#[tokio::test]
async fn sign_relays_the_request_and_returns_the_result() -> Result<()> {
    let _serial = SANDBOX.lock().await;
    let f = setup().await?;

    let out: Value = f
        .parent
        .call(&f.invoice_id, "sign")
        .args_json(json!({
            "payload": { "Ecdsa": "00ff" },
            "path": "evm-1",
            "domain_id": 0,
            "gas_tgas": 100,
        }))
        .max_gas()
        .transact()
        .await?
        .json()?;

    assert_eq!(out["signature"], "mock-signature");
    assert_eq!(out["request"]["payload_v2"], json!({ "Ecdsa": "00ff" }));
    assert_eq!(out["request"]["path"], "evm-1");
    assert_eq!(out["request"]["domain_id"], 0);

    let last: Option<String> = f.signer.view("last_call").await?.json()?;
    assert!(last.expect("signer mock was called").contains("sign"));
    Ok(())
}
