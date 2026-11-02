//! Sandbox-only mock of `v1.signer`. NEVER deployed to mainnet (blueprint §3.2).
//!
//! Method list (ag2's fixture and the vault tests depend on these names):
//! - `sign(request)` — payable; requires exactly 1 yocto. `request` is the real shape
//!   `{ "payload_v2": { "Ecdsa"|"Eddsa": "<hex>" }, "path": "<string>", "domain_id": <u64> }`.
//!   Returns the real response SHAPES recorded in K15 (deterministic functions of the payload):
//!   - Ecdsa: `{ "scheme": "Secp256k1", "big_r": { "affine_point": "02…" }, "s": { "scalar": "…" }, "recovery_id": 1 }`
//!   - Eddsa: `{ "scheme": "Ed25519", "signature": [64 numbers] }`
//! - `signed_requests() -> Vec<Value>` — every request, in call order.
//! - `set_fail(fail: bool)` — test switch: make `sign` panic.
//! - `set_min_gas_tgas(min_tgas: u64)` — test switch: refuse calls with less prepaid gas
//!   (0 disables the check).
//!
//! No init call is needed: the state is `Default`.
//! Shipped-once code lives in `contracts/vault` and `contracts/openrail`; this crate is only
//! compiled for sandbox tests and is not in the `make contract` / `wasm-check` release set.

use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require};

#[near(contract_state)]
#[derive(Default)]
pub struct SignerMock {
    requests: Vec<String>,
    min_gas_tgas: u64,
    fail: bool,
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[near]
impl SignerMock {
    #[payable]
    pub fn sign(&mut self, request: Value) -> Value {
        require!(
            env::attached_deposit().as_yoctonear() == 1,
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        require!(!self.fail, "signer mock: forced failure");
        if self.min_gas_tgas > 0 {
            require!(
                env::prepaid_gas().as_tgas() >= self.min_gas_tgas,
                "signer mock: prepaid gas below min_gas_tgas"
            );
        }

        let payload = request
            .get("payload_v2")
            .unwrap_or_else(|| env::panic_str("request.payload_v2 required"));
        require!(
            request.get("path").and_then(Value::as_str).is_some(),
            "request.path required"
        );
        require!(
            request.get("domain_id").and_then(Value::as_u64).is_some(),
            "request.domain_id required"
        );

        self.requests
            .push(near_sdk::serde_json::to_string(&request).expect("request serializes to JSON"));

        if let Some(payload_hex) = payload.get("Ecdsa").and_then(Value::as_str) {
            let x = env::sha256(payload_hex.as_bytes());
            let s = env::sha256(&x);
            return json!({
                "scheme": "Secp256k1",
                "big_r": { "affine_point": format!("02{}", hex(&x)) },
                "s": { "scalar": hex(&s) },
                "recovery_id": 1,
            });
        }
        if let Some(payload_hex) = payload.get("Eddsa").and_then(Value::as_str) {
            let a = env::sha256(payload_hex.as_bytes());
            let b = env::sha256(&a);
            let mut signature = a;
            signature.extend_from_slice(&b);
            return json!({ "scheme": "Ed25519", "signature": signature });
        }
        env::panic_str("unknown payload_v2 scheme")
    }

    pub fn signed_requests(&self) -> Vec<Value> {
        self.requests
            .iter()
            .filter_map(|request| near_sdk::serde_json::from_str(request).ok())
            .collect()
    }

    pub fn set_fail(&mut self, fail: bool) {
        self.fail = fail;
    }

    pub fn set_min_gas_tgas(&mut self, min_tgas: u64) {
        self.min_gas_tgas = min_tgas;
    }
}
