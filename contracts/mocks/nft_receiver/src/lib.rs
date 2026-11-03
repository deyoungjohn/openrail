//! Sandbox-only NEP-171 receiver that re-transfers the token inside `nft_on_transfer`.
//! Used to prove `nft_resolve_transfer` does not take back a token the receiver moved on.

use near_sdk::{env, near, AccountId, Gas, NearToken, Promise, PromiseOrValue};
use serde_json::Value;

#[near(contract_state)]
#[derive(Default)]
pub struct NftReceiver {}

#[near]
impl NftReceiver {
    pub fn nft_on_transfer(
        &self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> PromiseOrValue<bool> {
        let _ = (sender_id, previous_owner_id);
        let value: Value = serde_json::from_str(&msg).expect("receiver msg");
        let receiver_id: AccountId = value["receiver_id"]
            .as_str()
            .expect("receiver_id")
            .parse()
            .expect("account id");
        let memo = value["memo"].as_str().unwrap_or_default().to_string();
        let root = env::predecessor_account_id();
        let promise = Promise::new(root).function_call(
            "nft_transfer".to_string(),
            serde_json::json!({
                "receiver_id": receiver_id,
                "token_id": token_id,
                "approval_id": null,
                "memo": memo,
            })
            .to_string()
            .into_bytes(),
            NearToken::from_yoctonear(1),
            Gas::from_tgas(15),
        );
        PromiseOrValue::Promise(promise)
    }
}
