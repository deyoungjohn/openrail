//! Test environment (`Env`) fixture for openrail integration and sandbox tests.

use anyhow::{Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, CryptoHash, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountDetailsPatch, AccountId, Contract, Worker};
use openrail::types::{Config, Hex32, TokenId};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedMutexGuard};

fn sandbox_lock() -> &'static Arc<Mutex<()>> {
    static LOCK: std::sync::OnceLock<Arc<Mutex<()>>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Arc::new(Mutex::new(())))
}

fn seeded_key(id: &str) -> SecretKey {
    SecretKey::from_seed(KeyType::ED25519, id)
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(ALPHABET[(b0 >> 2) as usize] as char);
        out.push(ALPHABET[(((b0 & 0b11) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(((b1 & 0b1111) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(b2 & 0b111111) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// The integration test environment.
pub struct Env {
    pub worker: Worker<Sandbox>,
    /// Sandbox root authority account.
    pub parent: Account,
    /// Root contract deployed at `openrail.near`.
    pub root: Contract,
    /// Mock multi-token contract deployed at `intents.near`.
    pub intents: Contract,
    /// Mock MPC contract deployed at `v1.signer`.
    pub signer: Contract,
    /// Mock USDC NEP-141 contract deployed at `usdc.near`.
    pub usdc: Contract,
    /// Protocol fee recipient account.
    pub fees: Account,
    /// Authorized pump watcher account.
    pub watcher: Account,
    /// Authorized quote writer & claim issuer account.
    pub issuer: Account,
    /// Test user Alice.
    pub alice: Account,
    /// Test user Bob.
    pub bob: Account,
    /// Test user Carol.
    pub carol: Account,
    /// SHA256 code hash of the published vault global contract.
    pub vault_code_hash: Hex32,
    /// Lock held to guarantee single sandbox at a time.
    _lock: OwnedMutexGuard<()>,
}

impl Env {
    /// Starts the sandbox, compiles all required WASMs, publishes the vault globally,
    /// patches mocks, initializes `openrail.near`, and sets up test accounts.
    pub async fn new() -> Result<Self> {
        let lock = sandbox_lock().clone().lock_owned().await;

        let worker = near_workspaces::sandbox()
            .await
            .context("failed to start near-workspaces sandbox")?;

        // 1. Build or locate WASMs
        let root_wasm = crate::wasms::openrail_wasm().context("load root wasm")?;
        let vault_wasm = crate::wasms::vault_wasm().context("load vault wasm")?;
        let intents_wasm = crate::wasms::mock_intents_wasm().context("load mock intents wasm")?;
        let signer_wasm = crate::wasms::mock_signer_wasm().context("load mock signer wasm")?;
        let usdc_wasm = crate::wasms::mock_usdc_wasm().context("load mock usdc wasm")?;

        // 2. Deploy mocks at reserved top-level accounts via state patching
        let intents_id: AccountId = "intents.near".parse().unwrap();
        let intents_key = seeded_key("intents.near");
        worker
            .patch(&intents_id)
            .account(AccountDetailsPatch::default().balance(NearToken::from_near(100)))
            .access_key(intents_key.public_key(), AccessKey::full_access())
            .code(&intents_wasm)
            .transact()
            .await
            .context("patch intents.near")?;
        let intents = Contract::from_secret_key(intents_id, intents_key, &worker);

        let signer_id: AccountId = "v1.signer".parse().unwrap();
        let signer_key = seeded_key("v1.signer");
        worker
            .patch(&signer_id)
            .account(AccountDetailsPatch::default().balance(NearToken::from_near(100)))
            .access_key(signer_key.public_key(), AccessKey::full_access())
            .code(&signer_wasm)
            .transact()
            .await
            .context("patch v1.signer")?;
        let signer = Contract::from_secret_key(signer_id, signer_key, &worker);

        let usdc_id: AccountId = "usdc.near".parse().unwrap();
        let usdc_key = seeded_key("usdc.near");
        worker
            .patch(&usdc_id)
            .account(AccountDetailsPatch::default().balance(NearToken::from_near(100)))
            .access_key(usdc_key.public_key(), AccessKey::full_access())
            .code(&usdc_wasm)
            .transact()
            .await
            .context("patch usdc.near")?;
        let usdc = Contract::from_secret_key(usdc_id, usdc_key, &worker);

        // 3. Publish the vault as a global contract via a helper publisher account
        let parent = worker.root_account()?;
        let publisher = parent
            .create_subaccount("publisher")
            .initial_balance(NearToken::from_near(10))
            .transact()
            .await?
            .into_result()
            .context("create publisher account")?;

        let helper = publisher.deploy(&intents_wasm).await?.into_result()?;

        let res = helper
            .call("publish_vault")
            .args_json(json!({ "code": base64_encode(&vault_wasm) }))
            .max_gas()
            .deposit(NearToken::from_near(1))
            .transact()
            .await
            .context("call helper.publish_vault")?;

        let hash_bs58: String = res.json().context("parse publish_vault hash string")?;
        let hash: CryptoHash = hash_bs58.parse().context("parse CryptoHash from bs58")?;
        let vault_code_hash = Hex32::new(hash.0);

        // 4. Create standard test accounts
        let fees = parent
            .create_subaccount("fees")
            .initial_balance(NearToken::from_near(100))
            .transact()
            .await?
            .into_result()
            .context("create fees account")?;

        let watcher = parent
            .create_subaccount("watcher")
            .initial_balance(NearToken::from_near(100))
            .transact()
            .await?
            .into_result()
            .context("create watcher account")?;

        let issuer = parent
            .create_subaccount("issuer")
            .initial_balance(NearToken::from_near(100))
            .transact()
            .await?
            .into_result()
            .context("create issuer account")?;

        let alice = parent
            .create_subaccount("alice")
            .initial_balance(NearToken::from_near(1_000))
            .transact()
            .await?
            .into_result()
            .context("create alice account")?;

        let bob = parent
            .create_subaccount("bob")
            .initial_balance(NearToken::from_near(1_000))
            .transact()
            .await?
            .into_result()
            .context("create bob account")?;

        let carol = parent
            .create_subaccount("carol")
            .initial_balance(NearToken::from_near(100))
            .transact()
            .await?
            .into_result()
            .context("create carol account")?;

        // 5. Deploy root contract at openrail.near and initialize with Config
        let root_id: AccountId = "openrail.near".parse().unwrap();
        let root_key = seeded_key("openrail.near");
        worker
            .patch(&root_id)
            .account(AccountDetailsPatch::default().balance(NearToken::from_near(100)))
            .access_key(root_key.public_key(), AccessKey::full_access())
            .code(&root_wasm)
            .transact()
            .await
            .context("patch openrail.near")?;
        let root = Contract::from_secret_key(root_id, root_key, &worker);

        let settlement_assets: Vec<TokenId> = vec![
            "nep141:usdc.near".to_string(),
            "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near".to_string(),
            "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near".to_string(),
            "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near".to_string(),
        ];

        let config = Config {
            settlement_assets,
            vault_code_hash,
            fee_account: fees.id().clone(),
            watchers: vec![watcher.id().clone()],
            quote_writers: vec![issuer.id().clone()],
            issuers: vec![issuer.id().clone()],
            issue_paused: false,
        };

        parent
            .call(root.id(), "new")
            .args_json(json!({ "config": config }))
            .max_gas()
            .transact()
            .await
            .context("initialize openrail root contract")?
            .into_result()
            .context("openrail new into_result")?;

        Ok(Self {
            worker,
            parent,
            root,
            intents,
            signer,
            usdc,
            fees,
            watcher,
            issuer,
            alice,
            bob,
            carol,
            vault_code_hash,
            _lock: lock,
        })
    }
}
