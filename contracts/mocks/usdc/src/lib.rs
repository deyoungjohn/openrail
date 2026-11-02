//! Sandbox-only mock NEP-141 USDC (6 decimals). NEVER deployed to mainnet (blueprint §3.2).
//! Hand-written; no `near-contract-standards`.
//!
//! Method list (ag2's fixture and the service tests depend on these names):
//! - `ft_metadata() -> FtMetadata` — `ft-1.0.0`, symbol USDC, 6 decimals.
//! - `ft_balance_of(account_id) -> U128`
//! - `ft_total_supply() -> U128`
//! - `storage_deposit(account_id?: AccountId)` — payable; registers the account.
//! - `storage_balance_of(account_id) -> Option<StorageBalance>`
//! - `ft_transfer(receiver_id, amount, memo?)` — payable; exactly 1 yocto.
//! - `ft_transfer_call(receiver_id, amount, memo?, msg)` — payable; exactly 1 yocto;
//!   calls `ft_on_transfer`, then refunds unused tokens in `ft_resolve_transfer`.
//! - `ft_resolve_transfer(sender_id, receiver_id, amount) -> U128` — private callback.
//! - `mint(account_id, amount)` — TEST ONLY; mints and registers.
//!
//! No init call is needed: `Default` sets the storage prefix.
//! This crate is only compiled for sandbox tests and is not in the `make contract` /
//! `wasm-check` release set.

use near_sdk::json_types::U128;
use near_sdk::serde_json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken};

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
struct FtAccount {
    balance: u128,
    registered: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct FtMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(contract_state)]
pub struct UsdcMock {
    accounts: LookupMap<AccountId, FtAccount>,
    total_supply: u128,
}

impl Default for UsdcMock {
    fn default() -> Self {
        Self {
            accounts: LookupMap::new(b"a"),
            total_supply: 0,
        }
    }
}

#[near]
impl UsdcMock {
    pub fn ft_metadata(&self) -> FtMetadata {
        FtMetadata {
            spec: "ft-1.0.0".to_string(),
            name: "USD Coin (sandbox)".to_string(),
            symbol: "USDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.account(&account_id).balance)
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> StorageBalance {
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        self.register(&account_id);
        StorageBalance {
            total: U128(1),
            available: U128(0),
        }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.accounts.get(&account_id).and_then(|account| {
            account.registered.then_some(StorageBalance {
                total: U128(1),
                available: U128(0),
            })
        })
    }

    /// Test-only faucet; registers the receiver as a side effect.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        let mut account = self.account(&account_id);
        account.registered = true;
        account.balance = account
            .balance
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("total supply overflow"));
        self.accounts.insert(account_id, account);
        self.total_supply = self
            .total_supply
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("total supply overflow"));
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        let _ = memo;
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        self.move_tokens(&env::predecessor_account_id(), &receiver_id, amount.0);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) {
        let _ = memo;
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        let sender_id = env::predecessor_account_id();
        self.move_tokens(&sender_id, &receiver_id, amount.0);

        let call = env::promise_create(
            receiver_id.clone(),
            "ft_on_transfer",
            serde_json::json!({
                "sender_id": sender_id,
                "amount": amount,
                "msg": msg,
            })
            .to_string()
            .as_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(20),
        );
        let resolve = env::promise_then(
            call,
            env::current_account_id(),
            "ft_resolve_transfer",
            serde_json::json!({
                "sender_id": sender_id,
                "receiver_id": receiver_id,
                "amount": amount,
            })
            .to_string()
            .as_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(10),
        );
        env::promise_return(resolve);
    }

    /// NEP-141 resolve step: refund the unused amount (at most the receiver's balance).
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let unused = match env::promise_result_checked(0, 1024) {
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes)
                .map(|value| value.0.min(amount.0))
                .unwrap_or(amount.0),
            Err(_) => amount.0,
        };
        let refund = unused.min(self.account(&receiver_id).balance);
        if refund > 0 {
            let mut receiver = self.account(&receiver_id);
            receiver.balance -= refund;
            self.accounts.insert(receiver_id, receiver);
            let mut sender = self.account(&sender_id);
            sender.balance += refund;
            self.accounts.insert(sender_id, sender);
        }
        U128(amount.0 - refund)
    }
}

impl UsdcMock {
    fn account(&self, account_id: &AccountId) -> FtAccount {
        self.accounts.get(account_id).cloned().unwrap_or_default()
    }

    fn register(&mut self, account_id: &AccountId) {
        let mut account = self.account(account_id);
        account.registered = true;
        self.accounts.insert(account_id.clone(), account);
    }

    fn move_tokens(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        require!(amount > 0, "The amount must be greater than zero");
        require!(self.account(to).registered, "The account is not registered");
        let mut from_account = self.account(from);
        require!(
            from_account.balance >= amount,
            "The account doesn't have enough balance"
        );
        from_account.balance -= amount;
        self.accounts.insert(from.clone(), from_account);

        let mut to_account = self.account(to);
        to_account.balance += amount;
        self.accounts.insert(to.clone(), to_account);
    }
}
