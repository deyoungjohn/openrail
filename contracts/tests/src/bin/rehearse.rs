//! Sandbox rehearsal for the deploy runbook.
//!
//! Starts the local NEAR sandbox through the shared `Env` fixture, adds the restricted
//! function-call keys, issues two invoices through the real issuer service, pays them
//! through the mock intents contract, lets the real watcher reconcile and retry, then reads
//! both receipts from the real indexer service. Every step prints its equivalent command.

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
const WATCHER_PORT: u16 = 18_080;
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

fn rpc_result(url: &str, method: &str, params: Value) -> Option<Value> {
    let output = Command::new("curl")
        .args([
            "-fsS",
            "--max-time",
            "5",
            "-X",
            "POST",
            url,
            "-H",
            "content-type: application/json",
            "-d",
            &json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string(),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let body: Value = serde_json::from_slice(&output.stdout).ok()?;
    body.get("result").cloned()
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

fn issue_via_issuer(port: u16, service_key: &str, body: &Value) -> Result<Value> {
    let response = Command::new("curl")
        .args([
            "-fsS",
            "-X",
            "POST",
            &format!("http://127.0.0.1:{port}/issue"),
            "-H",
            &format!("Authorization: Bearer {service_key}"),
            "-H",
            "content-type: application/json",
            "-d",
            &serde_json::to_string(body)?,
        ])
        .output()
        .context("call issuer /issue")?;
    if !response.status.success() {
        bail!(
            "issuer /issue failed: {}",
            String::from_utf8_lossy(&response.stderr)
        );
    }
    Ok(serde_json::from_slice(&response.stdout)?)
}

fn field_amount(value: &Value, field: &str) -> u128 {
    value[field]
        .as_str()
        .and_then(|raw| raw.parse::<u128>().ok())
        .unwrap_or(0)
}

fn undistributed(value: &Value) -> usize {
    value["undistributed"]
        .as_array()
        .map(|legs| legs.len())
        .unwrap_or(0)
}

async fn view_claim(env: &Env, token_id: &str) -> Result<Value> {
    env.root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()
        .context("claim view")
}

async fn wait_claim<F>(env: &Env, token_id: &str, label: &str, mut ready: F) -> Result<Value>
where
    F: FnMut(&Value) -> bool,
{
    for _ in 0..300 {
        let claim = view_claim(env, token_id).await?;
        if ready(&claim) {
            return Ok(claim);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    bail!("timed out waiting for {label} on {token_id}")
}

fn wait_booked_tx(port: u16, token_id: &str) -> Result<String> {
    let url = format!("http://127.0.0.1:{port}/history?token_id={token_id}");
    for _ in 0..300 {
        if let Some(body) = curl(&url) {
            if let Some(events) = body["data"].as_array() {
                for event in events {
                    if event["event"] == "booked" {
                        if let Some(hash) = event["tx_hash"].as_str() {
                            return Ok(hash.to_string());
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    bail!("timed out waiting for the booked event on {token_id}")
}

fn wait_receipt(port: u16, tx_hash: &str) -> Result<Value> {
    let url = format!("http://127.0.0.1:{port}/r/{tx_hash}");
    for _ in 0..300 {
        if let Some(body) = curl(&url) {
            return Ok(body);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    bail!("timed out waiting for the receipt {tx_hash}")
}

fn method_ready(name: &str) -> bool {
    let abi_path = root_dir().join("abi/openrail.core.json");
    let Ok(body) = std::fs::read_to_string(abi_path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&body) else {
        return false;
    };
    let in_abi = value["methods"]
        .as_array()
        .is_some_and(|methods| methods.iter().any(|method| method["name"] == name));
    if !in_abi {
        return false;
    }
    let source_path = root_dir().join("contracts/openrail/src/lib.rs");
    let Ok(source) = std::fs::read_to_string(source_path) else {
        return false;
    };
    let Some(start) = source.find(&format!("pub fn {name}")) else {
        return false;
    };
    let body = &source[start..];
    let Some(end) = body.find("\n    }") else {
        return false;
    };
    !body[..end].contains("NOT_IMPLEMENTED")
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
    add_function_key(
        &env.watcher,
        watcher_key.public_key(),
        &["reconcile", "retry_distribution", "clear_stale_lock"],
        &root,
        NearToken::from_near(50),
    )
    .await?;
    show(&format!(
        "near account add-key {} grant-function-call-access --allowance '5 NEAR' --contract-account-id {} --function-names 'issue_for,log_quote' use-manually-provided-public-key {} network-config localnet sign-with-access-key-file <sandbox-key> send",
        env.issuer.id(), root, issuer_key.public_key()
    ));
    show(&format!(
        "near account add-key {} grant-function-call-access --allowance '0.5 NEAR' --contract-account-id {} --function-names 'acknowledge_evm' use-manually-provided-public-key {} network-config localnet sign-with-access-key-file <sandbox-key> send",
        env.issuer.id(), root, relay_key.public_key()
    ));
    show(&format!(
        "near account add-key {} grant-function-call-access --allowance '50 NEAR' --contract-account-id {} --function-names 'reconcile,retry_distribution,clear_stale_lock' use-manually-provided-public-key {} network-config localnet sign-with-access-key-file <sandbox-key> send",
        env.watcher.id(), root, watcher_key.public_key()
    ));
    println!();

    let head = rpc_result(&rpc_url, "block", json!({ "finality": "final" }))
        .and_then(|body| body["header"]["height"].as_u64())
        .context("read sandbox head")?;
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
            ("INDEXER_START_HEIGHT", head.to_string()),
            ("INDEXER_DB_PATH", db.to_string_lossy().to_string()),
            ("INDEXER_PORT", INDEXER_PORT.to_string()),
            ("INDEXER_POLL_INTERVAL_MS", "1000".to_string()),
            ("INDEXER_RETENTION_DAYS", "1".to_string()),
        ],
    )?;
    wait_for("indexer health", || {
        curl(&format!("http://127.0.0.1:{INDEXER_PORT}/health")).is_some()
    })?;

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

    println!("## 3. Fund storage credit and issue two invoices through the issuer");
    env.alice
        .call(&root, "deposit_storage_credit")
        .deposit(NearToken::from_millinear(200))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .context("deposit storage credit")?;
    show(&format!(
        "near contract call-function as-transaction {} deposit_storage_credit json-args '{{}}' prepaid-gas '100 Tgas' attached-deposit '0.2 NEAR' sign-as {} network-config localnet sign-with-access-key-file <sandbox-key> send",
        root, env.alice.id()
    ));

    let amount = 1_000_000u128;
    let mut tokens = Vec::new();
    let mut claim_accounts = Vec::new();
    for suffix in ["11", "22"] {
        let body = json!({
            "business": env.alice.id(),
            "kind": 0,
            "debtor": { "Near": env.bob.id() },
            "termsHash": format!("0x{}", suffix.repeat(32)),
            "amountDue": amount.to_string(),
            "dueDate": 1_800_000_000u64,
        });
        show(&format!(
            "curl -sS -X POST http://127.0.0.1:{ISSUER_PORT}/issue -H 'Authorization: Bearer ***' -H 'content-type: application/json' -d '{}'",
            serde_json::to_string(&body)?
        ));
        let issued = issue_via_issuer(ISSUER_PORT, &service_key, &body)?;
        tokens.push(
            issued["tokenId"]
                .as_str()
                .context("tokenId from issuer")?
                .to_string(),
        );
        claim_accounts.push(
            issued["claimAccount"]
                .as_str()
                .context("claimAccount from issuer")?
                .to_string(),
        );
        println!("issued token_id={}", tokens.last().unwrap());
    }
    let (token_ok, token_fail) = (&tokens[0], &tokens[1]);
    let (account_ok, account_fail) = (&claim_accounts[0], &claim_accounts[1]);
    println!();

    println!("## 4. Set up the failure leg: sell one claim to a missing account");
    env.bob
        .call(&root, "acknowledge_near")
        .args_json(json!({ "token_id": token_fail }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .context("acknowledge failing claim")?;
    show(&format!(
        "near contract call-function as-transaction {} acknowledge_near json-args '{{\"token_id\":\"{token_fail}\"}}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as {} network-config localnet sign-with-access-key-file <sandbox-key> send",
        root, env.bob.id()
    ));
    let missing = format!("missing-owner.{}", env.parent.id());
    env.alice
        .call(&root, "nft_transfer")
        .args_json(json!({
            "receiver_id": missing,
            "token_id": token_fail,
            "approval_id": null,
            "memo": "33".repeat(32),
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .context("transfer to missing owner")?;
    show(&format!(
        "near contract call-function as-transaction {} nft_transfer json-args '{{\"receiver_id\":\"{missing}\",\"token_id\":\"{token_fail}\",\"approval_id\":null,\"memo\":\"{}\"}}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as {} network-config localnet sign-with-access-key-file <sandbox-key> send",
        root, "33".repeat(32), env.alice.id()
    ));

    // Sandbox fault injection: replace the claim vault with a contract that has no
    // `forward` method, so the payment leg fails while the booking stays (D-S8).
    show(&format!(
        "# sandbox fault injection: replace {account_fail}'s vault code with a stub (not a mainnet step)"
    ));
    let claim_id: near_workspaces::AccountId = account_fail.parse()?;
    env.worker
        .patch(&claim_id)
        .code(&openrail_tests::wasms::mock_usdc_wasm()?)
        .transact()
        .await
        .context("inject failing vault code")?;
    println!();

    let watcher = spawn_service(
        &[
            "--filter",
            "@openrail/watcher",
            "exec",
            "tsx",
            "src/index.ts",
        ],
        &[
            ("NEAR_ENV", "testnet".to_string()),
            ("NEAR_ROOT_ACCOUNT", root.to_string()),
            ("NEAR_RPC_URL", rpc_url.clone()),
            ("NEAR_RPC_URL_FALLBACK", rpc_url.clone()),
            ("WATCHER_ACCOUNT_ID", env.watcher.id().to_string()),
            ("WATCHER_PRIVATE_KEY", watcher_key.to_string()),
            ("WATCHER_POLL_INTERVAL_MS", "1000".to_string()),
            ("WATCHER_SLOW_INTERVAL_MS", "1000".to_string()),
            ("WATCHER_HEALTH_PORT", WATCHER_PORT.to_string()),
            ("WATCHER_EXTRA_CLAIMS", format!("{token_ok},{token_fail}")),
        ],
    )?;
    wait_for("watcher health", || {
        curl(&format!("http://127.0.0.1:{WATCHER_PORT}/health")).is_some()
    })?;

    println!("## 5. Pay both claims through the mock; the watcher reconciles");
    for account in [account_ok, account_fail] {
        env.parent
            .call(env.intents.id(), "mt_mint")
            .args_json(json!({
                "account_id": account,
                "token_id": DEFAULT_SETTLEMENT_ASSET,
                "amount": U128(amount),
            }))
            .max_gas()
            .transact()
            .await?
            .into_result()
            .context("mock payment")?;
        show(&format!(
            "near contract call-function as-transaction intents.near mt_mint json-args '{{\"account_id\":\"{account}\",\"token_id\":\"{DEFAULT_SETTLEMENT_ASSET}\",\"amount\":\"{amount}\"}}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as <parent> network-config localnet sign-with-access-key-file <sandbox-key> send"
        ));
    }
    show(&format!(
        "# the watcher service calls reconcile for {token_ok} and {token_fail}; equivalent:"
    ));
    show(&format!(
        "near contract call-function as-transaction {} reconcile json-args '{{\"token_id\":\"{token_ok}\"}}' prepaid-gas '250 Tgas' attached-deposit '0 NEAR' sign-as {} network-config localnet sign-with-access-key-file <watcher-key> send",
        root, env.watcher.id()
    ));

    let booked_ok = wait_claim(&env, token_ok, "booked happy claim", |claim| {
        field_amount(claim, "booked_total") > 0 && undistributed(claim) == 0
    })
    .await?;
    let blocked = wait_claim(&env, token_fail, "blocked distribution", |claim| {
        field_amount(claim, "booked_total") > 0 && undistributed(claim) > 0
    })
    .await?;
    println!(
        "happy claim booked_total={}",
        field_amount(&booked_ok, "booked_total")
    );
    println!(
        "failure claim booked_total={} undistributed_legs={} (forward to {missing} failed; D-S8 keeps the booking)",
        field_amount(&blocked, "booked_total"),
        undistributed(&blocked)
    );
    println!();

    println!("## 6. Receipts from the indexer (including the failed forward)");
    let tx_ok = wait_booked_tx(INDEXER_PORT, token_ok)?;
    let tx_fail = wait_booked_tx(INDEXER_PORT, token_fail)?;
    show(&format!(
        "curl -sS http://127.0.0.1:{INDEXER_PORT}/r/{tx_ok}"
    ));
    show(&format!(
        "curl -sS http://127.0.0.1:{INDEXER_PORT}/r/{tx_fail}"
    ));
    let receipt_ok = wait_receipt(INDEXER_PORT, &tx_ok)?;
    let receipt_fail = wait_receipt(INDEXER_PORT, &tx_fail)?;
    println!(
        "receipt {}={}",
        token_ok,
        serde_json::to_string_pretty(&receipt_ok)?
    );
    println!(
        "receipt {}={}",
        token_fail,
        serde_json::to_string_pretty(&receipt_fail)?
    );
    println!();

    println!("## 7. Create the missing account; the watcher retries the distribution");
    println!("# the watcher service calls retry_distribution automatically; equivalent:");
    show(&format!(
        "near account create-account fund-myself {missing} '5 NEAR' autogenerate-new-keypair save-to-keychain network-config localnet sign-with-access-key-file <sandbox-key> send"
    ));
    env.parent
        .create_subaccount("missing-owner")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()
        .context("create missing owner")?;
    show(&format!(
        "# sandbox fault recovery: restore {account_fail}'s vault code (not a mainnet step)"
    ));
    env.worker
        .patch(&claim_id)
        .code(&openrail_tests::wasms::vault_wasm()?)
        .transact()
        .await
        .context("restore claim vault code")?;
    show(&format!(
        "near contract call-function as-transaction {} retry_distribution json-args '{{\"token_id\":\"{token_fail}\"}}' prepaid-gas '250 Tgas' attached-deposit '0 NEAR' sign-as {} network-config localnet sign-with-access-key-file <watcher-key> send",
        root, env.watcher.id()
    ));
    let retried = wait_claim(&env, token_fail, "retry distribution", |claim| {
        undistributed(claim) == 0 && field_amount(claim, "distributed_total") > 0
    })
    .await?;
    println!(
        "retry claim {token_fail}: distributed_total={} undistributed_legs={}",
        field_amount(&retried, "distributed_total"),
        undistributed(&retried)
    );
    println!();

    println!("## 8. Surplus release");
    if method_ready("release_surplus") {
        let surplus_amount = amount / 2;
        env.parent
            .call(env.intents.id(), "mt_mint")
            .args_json(json!({
                "account_id": account_ok,
                "token_id": DEFAULT_SETTLEMENT_ASSET,
                "amount": U128(surplus_amount),
            }))
            .max_gas()
            .transact()
            .await?
            .into_result()
            .context("overpay for surplus")?;
        show(&format!(
            "near contract call-function as-transaction intents.near mt_mint json-args '{{\"account_id\":\"{account_ok}\",\"token_id\":\"{DEFAULT_SETTLEMENT_ASSET}\",\"amount\":\"{surplus_amount}\"}}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as <parent> network-config localnet sign-with-access-key-file <sandbox-key> send"
        ));
        let surplus_watcher =
            Account::from_secret_key(env.watcher.id().clone(), watcher_key.clone(), &env.worker);
        surplus_watcher
            .call(&root, "reconcile")
            .args_json(json!({ "token_id": token_ok }))
            .max_gas()
            .transact()
            .await?
            .into_result()
            .context("reconcile surplus")?;
        show(&format!(
            "near contract call-function as-transaction {} reconcile json-args '{{\"token_id\":\"{token_ok}\"}}' prepaid-gas '250 Tgas' attached-deposit '0 NEAR' sign-as {} network-config localnet sign-with-access-key-file <watcher-key> send",
            root, env.watcher.id()
        ));
        let with_surplus = wait_claim(&env, token_ok, "surplus booking", |claim| {
            field_amount(claim, "surplus") > 0
        })
        .await?;
        println!(
            "surplus before release={}",
            field_amount(&with_surplus, "surplus")
        );
        show(&format!(
            "near contract call-function as-transaction {} release_surplus json-args '{{\"token_id\":\"{token_ok}\"}}' prepaid-gas '250 Tgas' attached-deposit '0 NEAR' sign-as {} network-config localnet sign-with-access-key-file <sandbox-key> send",
            root, env.alice.id()
        ));
        env.alice
            .call(&root, "release_surplus")
            .args_json(json!({ "token_id": token_ok }))
            .max_gas()
            .transact()
            .await?
            .into_result()
            .context("release surplus")?;
        let released = wait_claim(&env, token_ok, "surplus release", |claim| {
            field_amount(claim, "surplus") == 0
        })
        .await?;
        println!(
            "surplus after release={}",
            field_amount(&released, "surplus")
        );
    } else {
        println!(
            "# skipped: release_surplus is still the NOT_IMPLEMENTED stub (ag2 #71); the step runs automatically once it lands"
        );
    }
    println!();

    drop(indexer);
    drop(watcher);
    drop(issuer);
    println!("rehearsal ok: deploy, keys, issuer issues, mock payments, watcher reconcile, failed forward, retry, receipts, surplus");
    Ok(())
}
