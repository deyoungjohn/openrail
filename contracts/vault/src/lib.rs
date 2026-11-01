//! Openrail vault: shell only. Vault v2 is built in P0.4.
use near_sdk::near;

/// Placeholder state so that `cargo near build` has a contract to extract an ABI from.
#[near(contract_state)]
#[derive(Default)]
pub struct Vault {}

#[near]
impl Vault {}
