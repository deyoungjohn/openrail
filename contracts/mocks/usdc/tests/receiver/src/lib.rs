//! Sandbox receiver for `ft_transfer_call` tests.
//! `ft_on_transfer` returns the unused amount: `"keep"` uses all, `"refund"` uses none.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

#[near(contract_state)]
#[derive(Default)]
pub struct Receiver {}

#[near]
impl Receiver {
    pub fn ft_on_transfer(&self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let _ = sender_id;
        match msg.as_str() {
            "keep" => U128(0),
            "refund" => amount,
            other => near_sdk::env::panic_str(&format!("unknown msg: {other}")),
        }
    }
}
