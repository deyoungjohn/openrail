//! Sandbox fixture only. Never deployed by the product.
//!
//! One wasm is deployed twice by the sandbox tests:
//! - on the root account: publishes the vault as a global contract and creates keyless accounts
//!   that use it by hash (the K1 flow);
//! - at `intents.near`: records and echoes `mt_transfer` calls.
//! The shared `v1.signer` mock lives in `contracts/mocks/signer` (P0.6b).

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8};
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, AccountId, CryptoHash, NearToken, Promise};

#[near(contract_state)]
#[derive(Default)]
pub struct Mock {
    vault_hash: Option<CryptoHash>,
    last_call: Option<String>,
}

#[near]
impl Mock {
    /// Publishes `code` as a global contract by hash and returns the hash.
    #[payable]
    pub fn publish_vault(&mut self, code: Base64VecU8) -> Base58CryptoHash {
        let code: Vec<u8> = code.into();
        let hash = env::sha256_array(&code);
        self.vault_hash = Some(hash);
        Promise::new(env::current_account_id())
            .deploy_global_contract(code)
            .detach();
        hash.into()
    }

    /// Creates `<prefix>-<n>.<this account>` with no access key, running the global vault.
    pub fn create_keyless(&mut self, prefix: String, n: u64) -> Promise {
        let hash = self
            .vault_hash
            .expect("publish_vault must run first");
        let id: AccountId = format!("{prefix}-{n}.{}", env::current_account_id())
            .parse()
            .expect("valid account id");
        Promise::new(id)
            .create_account()
            .transfer(NearToken::from_millinear(100))
            .use_global_contract(hash)
    }

    /// NEP-141-like receiver. Echoes the arguments so the caller can assert them.
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: String,
    ) -> Value {
        self.last_call = Some(
            json!({
                "method": "mt_transfer",
                "receiver_id": receiver_id,
                "token_id": token_id,
                "amount": amount,
            })
            .to_string(),
        );
        json!({
            "receiver_id": receiver_id,
            "token_id": token_id,
            "amount": amount,
        })
    }

    pub fn last_call(&self) -> Option<String> {
        self.last_call.clone()
    }
}
