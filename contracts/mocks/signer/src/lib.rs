//! Sandbox-only mock of `v1.signer`. NEVER deployed to mainnet (blueprint §3.2).
//!
//! Method list (ag2's fixture and the vault tests depend on these names):
//! - `sign(request)` — payable; requires exactly 1 yocto. `request` is the real shape
//!   `{ "payload_v2": { "Ecdsa"|"Eddsa": "<hex>" }, "path": "<string>", "domain_id": <u64> }`.
//!   Returns the real response SHAPES recorded in K15 (deterministic functions of the payload).
//! - `signed_requests() -> Vec<Value>` — every request, in call order.
//! - `set_fail(fail: bool)` — test switch: make `sign` panic.
//! - `set_min_gas_tgas(min_tgas: u64)` — test switch: refuse calls with less prepaid gas
//!   (0 disables the check).
//!
//! Shipped-once code lives in `contracts/vault` and `contracts/openrail`; this crate is only
//! compiled for sandbox tests and is not in the `make contract` / `wasm-check` release set.

use near_sdk::near;

/// Placeholder so the tests-first commit compiles; the methods are implemented in P0.6b.
#[near(contract_state)]
#[derive(Default)]
pub struct SignerMock {}

#[near]
impl SignerMock {}
