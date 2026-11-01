//! Openrail root contract: shell only. The interface is frozen in P0.3.
use near_sdk::near;

/// Placeholder state so that `cargo near build` has a contract to extract an ABI from.
#[near(contract_state)]
#[derive(Default)]
pub struct Contract {}

#[near]
impl Contract {}
