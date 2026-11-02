//! Sandbox-only mock of `intents.near` (Blueprint 1.5.9). NEVER deployed to mainnet.
//!
//! Method list (fixture and contract tests depend on these names):
//! - `mt_balance_of(account_id: AccountId, token_id: String) -> U128`
//! - `mt_batch_balance_of(account_id: AccountId, token_ids: Vec<String>) -> Vec<U128>`
//! - `mt_transfer(receiver_id: AccountId, token_id: String, amount: U128, approval: Option<()>, memo: Option<String>)` (1 yocto)
//! - `mt_transfer_call(receiver_id: AccountId, token_id: String, amount: U128, approval: Option<()>, memo: Option<String>, msg: String) -> Promise` (1 yocto)
//! - `mt_resolve_transfer(sender_id: AccountId, receiver_id: AccountId, token_id: String, amount: U128) -> U128` (private callback)
//! - `mt_mint(account_id: AccountId, token_id: String, amount: U128)` — test-only helper to credit any token ID.
//! - `publish_vault(code: Base64VecU8) -> Base58CryptoHash` — test-only sandbox helper to publish vault code globally (Protocol 86); strictly sandbox-only and excluded from production `make contract`.
//!
//! Non-existent accounts return 0 (credits to uncreated accounts land, blueprint 1.5.9).

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U128};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise};

const GAS_FOR_MT_ON_TRANSFER: Gas = Gas::from_tgas(30);
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(10);

#[near(contract_state)]
pub struct MockIntents {
    balances: LookupMap<String, u128>,
    transfers: Vec<String>,
}

impl Default for MockIntents {
    fn default() -> Self {
        Self {
            balances: LookupMap::new(b"b"),
            transfers: Vec::new(),
        }
    }
}

fn balance_key(account_id: &AccountId, token_id: &str) -> String {
    format!("{}:{}", account_id, token_id)
}

#[near]
impl MockIntents {
    /// Sandbox helper: publishes `code` as a global contract (Protocol 86) and returns the sha256 hash.
    #[payable]
    pub fn publish_vault(&mut self, code: Base64VecU8) -> Base58CryptoHash {
        let code: Vec<u8> = code.into();
        let hash = env::sha256_array(&code);
        Promise::new(env::current_account_id())
            .deploy_global_contract(code)
            .detach();
        hash.into()
    }
    /// Returns the balance of `token_id` for `account_id`.
    ///
    /// Non-existent accounts return 0 (credits to uncreated accounts land, blueprint 1.5.9).
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        let key = balance_key(&account_id, &token_id);
        U128(self.balances.get(&key).copied().unwrap_or(0))
    }

    /// Batch query for balances across multiple token IDs.
    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids
            .into_iter()
            .map(|token_id| self.mt_balance_of(account_id.clone(), token_id))
            .collect()
    }

    /// Transfers multi-token tokens between accounts. Requires 1 yoctoNEAR deposit.
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        #[allow(unused_variables)] approval: Option<()>,
        memo: Option<String>,
    ) {
        require!(
            env::attached_deposit().as_yoctonear() == 1,
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        let sender_id = env::predecessor_account_id();
        self.internal_transfer(&sender_id, &receiver_id, &token_id, amount.0);

        self.transfers.push(
            json!({
                "method": "mt_transfer",
                "sender_id": sender_id,
                "receiver_id": receiver_id,
                "token_id": token_id,
                "amount": amount,
                "memo": memo,
            })
            .to_string(),
        );
    }

    /// Transfers tokens and calls `mt_on_transfer` on the receiver contract.
    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        #[allow(unused_variables)] approval: Option<()>,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        require!(
            env::attached_deposit().as_yoctonear() == 1,
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        let sender_id = env::predecessor_account_id();
        self.internal_transfer(&sender_id, &receiver_id, &token_id, amount.0);

        self.transfers.push(
            json!({
                "method": "mt_transfer_call",
                "sender_id": sender_id,
                "receiver_id": receiver_id,
                "token_id": token_id,
                "amount": amount,
                "memo": memo,
                "msg": msg,
            })
            .to_string(),
        );

        let call_payload = json!({
            "sender_id": sender_id,
            "token_id": token_id,
            "amount": amount,
            "msg": msg,
        })
        .to_string();

        let resolve_payload = json!({
            "sender_id": sender_id,
            "receiver_id": receiver_id,
            "token_id": token_id,
            "amount": amount,
        })
        .to_string();

        Promise::new(receiver_id)
            .function_call(
                "mt_on_transfer".to_string(),
                call_payload.into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_FOR_MT_ON_TRANSFER,
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "mt_resolve_transfer".to_string(),
                resolve_payload.into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_FOR_RESOLVE_TRANSFER,
            ))
    }

    /// Resolves `mt_transfer_call` after `mt_on_transfer` executes.
    #[private]
    pub fn mt_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
    ) -> U128 {
        let unused_amount = match env::promise_result_checked(0, 1024) {
            Ok(bytes) => near_sdk::serde_json::from_slice::<U128>(&bytes)
                .map(|val| val.0.min(amount.0))
                .unwrap_or(amount.0),
            Err(_) => amount.0,
        };

        if unused_amount > 0 {
            // Refund unused amount from receiver back to sender
            let receiver_key = balance_key(&receiver_id, &token_id);
            let receiver_bal = self.balances.get(&receiver_key).copied().unwrap_or(0);
            let refund = std::cmp::min(receiver_bal, unused_amount);
            self.balances.insert(receiver_key, receiver_bal - refund);

            let sender_key = balance_key(&sender_id, &token_id);
            let sender_bal = self.balances.get(&sender_key).copied().unwrap_or(0);
            self.balances.insert(sender_key, sender_bal + refund);
        }

        U128(unused_amount)
    }

    /// TEST ONLY: Mints tokens directly to an account (e.g. uncreated claim account or user).
    pub fn mt_mint(&mut self, account_id: AccountId, token_id: String, amount: U128) {
        let key = balance_key(&account_id, &token_id);
        let current = self.balances.get(&key).copied().unwrap_or(0);
        self.balances.insert(key, current + amount.0);
    }

    /// TEST ONLY: Returns recorded transfers.
    pub fn transfers(&self) -> Vec<Value> {
        self.transfers
            .iter()
            .filter_map(|t| near_sdk::serde_json::from_str(t).ok())
            .collect()
    }

    fn internal_transfer(
        &mut self,
        sender_id: &AccountId,
        receiver_id: &AccountId,
        token_id: &str,
        amount: u128,
    ) {
        let sender_key = balance_key(sender_id, token_id);
        let sender_bal = self.balances.get(&sender_key).copied().unwrap_or(0);
        require!(
            sender_bal >= amount,
            format!("intents mock: insufficient balance ({sender_bal} < {amount})")
        );
        self.balances.insert(sender_key, sender_bal - amount);

        let receiver_key = balance_key(receiver_id, token_id);
        let receiver_bal = self.balances.get(&receiver_key).copied().unwrap_or(0);
        self.balances.insert(receiver_key, receiver_bal + amount);
    }
}
