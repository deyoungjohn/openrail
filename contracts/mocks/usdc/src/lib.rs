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
//!   calls `ft_on_transfer`, then refunds unused tokens.
//! - `ft_resolve_transfer(sender_id, receiver_id, amount) -> U128` — private callback.
//! - `mint(account_id, amount)` — TEST ONLY; mints and registers.
//!
//! No init call is needed: `Default` sets the storage prefix.

use near_sdk::near;

/// Placeholder so the tests-first commit compiles; the methods are implemented in P0.6b.
#[near(contract_state)]
#[derive(Default)]
pub struct UsdcMock {}

#[near]
impl UsdcMock {}
