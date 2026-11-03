//! Sandbox rehearsal for the deploy runbook.
//!
//! Starts the local NEAR sandbox through the shared `Env` fixture, adds the restricted
//! function-call keys, runs the real issuer service, pays the claim through the mock
//! intents contract, reconciles it with the watcher key, then reads the receipt from the
//! real indexer service. Every step prints the equivalent near CLI / HTTP command.

use anyhow::{bail, Context, Result};
use near_sdk::json_types::U128;
use near_workspaces::network::NetworkInfo;
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use near_workspaces::Account;
use openrail_tests::{Env, DEFAULT_SETTLEMENT_ASSET};
use serde_json::{json, Value};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

const ISSUER_PORT: u16 = 18_787;
const INDEXER_PORT: u16 = 18_788;

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn show(command: &str) {
    println!("$ {command}");
}

fn root_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("workspace root")
}

fn curl(url: &str) -> Option<Value> {
    let output = Command::new("curl")
        .args(["-fsS", "--max-time", "5", url])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

fn wait_for<F>(label: &str, mut ready: F) -> Result<()>
where
    F: FnMut() -> bool,
{
    for _ in 0..240 {
        if ready() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    bail!("timed out waiting for {label}")
}

fn spawn_service(args: &[&str], envs: &[(&str, String)]) -> Result<ChildGuard> {
    let pnpm = std::env::var("PNPM").unwrap_or_else(|_| "pnpm".to_string());
    show(&format!("{pnpm} {}", args.join(" ")));
    let mut command = Command::new(pnpm);
    command
        .args(args)
        .current_dir(root_dir())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    for (key, value) in envs {
        command.env(key, value);
    }
    Ok(ChildGuard(command.spawn().context("start service")?))
}

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
    let issuer_key = SecretKey::from_seed(KeyType::ED25519, "rehearse-issuer");
    let relay_key = SecretKey::from_seed(KeyType::ED25519, "rehearse-relay");
    let watcher_key = SecretKey::from_seed(KeyType::ED25519, "rehearse-watcher");
    let service_key = format!("rehearse-service-{}", std::process::id());
    let config: Value = env.root.view("config").args_json(json!({})).await?.json()?;

    println!("# Openrail sandbox rehearsal");
    println!("# sandbox rpc: {rpc_url}");
    println!("# root: {root}");
    println!();
    println!("## 1. Deploy and initialize (the fixture performs these steps)");
    show(&format!(
        "near contract deploy {} use-file target/near/openrail/openrail.wasm with-init-call new json-args '{}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' network-config localnet sign-with-access-key-file <sandbox-key> send",
        root,
        serde_json::to_string(&config)?
    ));
    println!();

    println!("## 2. Restricted function-call keys");
    add_function_key(
        &env.issuer,
        issuer_key.public_key(),
        &["issue_for", "log_quote"],
        &root,
        NearToken::from_near(1),
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
    add_function_key(
        &env.watcher,
        watcher_key.public_key(),
        &["reconcile", "retry_distribution", "clear_stale_lock"],
        &root,
        NearToken::from_near(5),
    )
    .await?;
    show(&format!(
        "near account add-key {} grant-function-call-access --allowance '1 NEAR' --contract-account-id {} --function-names 'issue_for,log_quote' use-manually-provided-public-key {} network-config localnet sign-with-access-key-file <sandbox-key> send",
        env.issuer.id(), root, issuer_key.public_key()
    ));
    show(&format!(
        "near account add-key {} grant-function-call-access --allowance '0.5 NEAR' --contract-account-id {} --function-names 'acknowledge_evm' use-manually-provided-public-key {} network-config localnet sign-with-access-key-file <sandbox-key> send",
        env.issuer.id(), root, relay_key.public_key()
    ));
    show(&format!(
        "near account add-key {} grant-function-call-access --allowance '5 NEAR' --contract-account-id {} --function-names 'reconcile,retry_distribution,clear_stale_lock' use-manually-provided-public-key {} network-config localnet sign-with-access-key-file <sandbox-key> send",
        env.watcher.id(), root, watcher_key.public_key()
    ));
    println!();

    let issuer = spawn_service(
        &[
            "--filter",
            "@openrail/issuer",
            "exec",
            "tsx",
            "src/index.ts",
        ],
        &[
            ("NEAR_ENV", "testnet".to_string()),
            ("NEAR_ROOT_ACCOUNT", root.to_string()),
            ("NEAR_RPC_URL", rpc_url.clone()),
            ("NEAR_RPC_URL_FALLBACK", rpc_url.clone()),
            ("ISSUER_ACCOUNT_ID", env.issuer.id().to_string()),
            ("ISSUER_PRIVATE_KEY", issuer_key.to_string()),
            ("RELAY_PRIVATE_KEY", relay_key.to_string()),
            ("ISSUER_SERVICE_KEY", service_key.clone()),
            ("ISSUER_PORT", ISSUER_PORT.to_string()),
        ],
    )?;
    wait_for("issuer health", || {
        curl(&format!("http://127.0.0.1:{ISSUER_PORT}/health")).is_some()
    })?;

    println!("## 3. Fund storage credit and issue through the issuer");
    env.alice
        .call(&root, "deposit_storage_credit")
        .deposit(NearToken::from_millinear(50))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .context("deposit storage credit")?;
    show(&format!(
        "near contract call-function as-transaction {} deposit_storage_credit json-args '{{}}' prepaid-gas '100 Tgas' attached-deposit '0.05 NEAR' sign-as {} network-config localnet sign-with-access-key-file <sandbox-key> send",
        root, env.alice.id()
    ));

    let amount = 1_000_000u128;
    let terms_hash = format!("0x{}", "11".repeat(32));
    let issue_body = json!({
        "business": env.alice.id(),
        "kind": 0,
        "debtor": { "Near": env.bob.id() },
        "termsHash": terms_hash,
        "amountDue": amount.to_string(),
        "dueDate": 1_800_000_000u64,
    });
    show(&format!(
        "curl -sS -X POST http://127.0.0.1:{ISSUER_PORT}/issue -H 'Authorization: Bearer ***' -H 'content-type: application/json' -d '{}'",
        serde_json::to_string(&issue_body)?
    ));
    let response = Command::new("curl")
        .args([
            "-fsS",
            "-X",
            "POST",
            &format!("http://127.0.0.1:{ISSUER_PORT}/issue"),
            "-H",
            &format!("Authorization: Bearer {service_key}"),
            "-H",
            "content-type: application/json",
            "-d",
            &serde_json::to_string(&issue_body)?,
        ])
        .output()
        .context("call issuer /issue")?;
    if !response.status.success() {
        bail!(
            "issuer /issue failed: {}",
            String::from_utf8_lossy(&response.stderr)
        );
    }
    let issued: Value = serde_json::from_slice(&response.stdout)?;
    let token_id = issued["tokenId"]
        .as_str()
        .context("tokenId from issuer")?
        .to_string();
    let claim_account = issued["claimAccount"]
        .as_str()
        .context("claimAccount from issuer")?
        .to_string();
    println!("issued token_id={token_id} claim_account={claim_account}");
    println!();

    println!("## 4. Pay through the mock and reconcile");
    let reconcile =
        Account::from_secret_key(env.watcher.id().clone(), watcher_key.clone(), &env.worker);
    env.parent
        .call(env.intents.id(), "mt_mint")
        .args_json(json!({
            "account_id": claim_account,
            "token_id": DEFAULT_SETTLEMENT_ASSET,
            "amount": U128(amount),
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .context("mock payment")?;
    show(&format!(
        "near contract call-function as-transaction intents.near mt_mint json-args '{{\"account_id\":\"{claim_account}\",\"token_id\":\"{DEFAULT_SETTLEMENT_ASSET}\",\"amount\":\"{amount}\"}}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as <parent> network-config localnet sign-with-access-key-file <sandbox-key> send"
    ));

    show(&format!(
        "near contract call-function as-transaction {} reconcile json-args '{{\"token_id\":\"{token_id}\"}}' prepaid-gas '250 Tgas' attached-deposit '0 NEAR' sign-as {} network-config localnet sign-with-access-key-file <watcher-key> send",
        root, env.watcher.id()
    ));
    let reconciled = reconcile
        .call(&root, "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    if !reconciled.is_success() {
        bail!("reconcile failed: {:?}", reconciled.failures());
    }
    let tx_hash = reconciled.outcome().transaction_hash.to_string();
    println!("reconcile tx={tx_hash}");
    println!();

    let db = std::env::temp_dir().join(format!("openrail-rehearse-{}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&db);
    let indexer = spawn_service(
        &[
            "--filter",
            "@openrail/indexer",
            "exec",
            "tsx",
            "src/index.ts",
        ],
        &[
            ("NEAR_ENV", "testnet".to_string()),
            ("NEAR_ROOT_ACCOUNT", root.to_string()),
            ("NEAR_RPC_URL", rpc_url.clone()),
            ("NEAR_RPC_URL_FALLBACK", rpc_url.clone()),
            ("INDEXER_SOURCE", "rpc".to_string()),
            ("INDEXER_START_HEIGHT", "0".to_string()),
            ("INDEXER_DB_PATH", db.to_string_lossy().to_string()),
            ("INDEXER_PORT", INDEXER_PORT.to_string()),
            ("INDEXER_POLL_INTERVAL_MS", "1000".to_string()),
            ("INDEXER_RETENTION_DAYS", "1".to_string()),
        ],
    )?;
    wait_for("indexer health", || {
        curl(&format!("http://127.0.0.1:{INDEXER_PORT}/health")).is_some()
    })?;

    println!("## 5. Receipt from the indexer");
    show(&format!(
        "curl -sS http://127.0.0.1:{INDEXER_PORT}/r/{tx_hash}"
    ));
    let mut receipt: Option<Value> = None;
    wait_for("receipt", || {
        receipt = curl(&format!("http://127.0.0.1:{INDEXER_PORT}/r/{tx_hash}"));
        receipt.is_some()
    })?;
    let receipt = receipt.context("receipt body")?;
    println!("receipt={}", serde_json::to_string_pretty(&receipt)?);
    println!();

    drop(indexer);
    drop(issuer);
    println!("rehearsal ok: deploy, keys, issuer issue, mock payment, reconcile, indexer receipt");
    Ok(())
}
