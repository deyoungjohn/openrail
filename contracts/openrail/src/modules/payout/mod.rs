//! Support component: outbound payout (blueprint `_payout.md`).
//!
//! Moves value from a keyless account Openrail controls (a claim account) to a 1Click deposit
//! address through `vault.forward`, and reports the result to the module that asked. Compiled in
//! only when a module that needs it is enabled. State lives under the raw prefix `m:payout:` (no
//! new fields in the contract struct, so the deployed state layout is unchanged).

// Until the checkout contract part starts payouts, a checkout-only build compiles the component
// without a caller.
#![cfg_attr(not(feature = "settle"), allow(dead_code))]

use crate::{Contract, ContractExt};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, Gas, NearToken};

/// Gas for the cross-contract `forward` call on the source account (vault v2).
pub const GAS_FOR_PAYOUT_FORWARD: Gas = Gas::from_tgas(16);
/// Inner gas for `mt_transfer` inside `forward` (vault v2 bounds: 8–50).
pub const PAYOUT_FORWARD_INNER_TGAS: u64 = 12;
/// Gas for the `on_payout` callback.
pub const GAS_FOR_ON_PAYOUT: Gas = Gas::from_tgas(15);
/// Payouts one call may start. Each costs 16 Tgas (forward) + 15 Tgas (callback) attached plus the
/// caller's own work; 300 Tgas with a 20% margin leaves 240 Tgas, so 7 fit. To be re-measured in
/// the sandbox (`payout_batch_fits_gas`); K16 measured 6.35 Tgas real per forward.
pub const MAX_PAYOUTS_PER_CALL: u32 = 7;

const KEY_RELAYERS: &[u8] = b"m:payout:relayers";
const KEY_NEXT: &[u8] = b"m:payout:next";
const PREFIX_PAYOUT: &[u8] = b"m:payout:p:";

pub const ERR_NOT_RELAYER: &str = "PAYOUT_NOT_RELAYER";
pub const ERR_MODULE_NOT_ENABLED: &str = "PAYOUT_MODULE_NOT_ENABLED";
pub const ERR_ZERO_AMOUNT: &str = "PAYOUT_ZERO_AMOUNT";
pub const ERR_UNKNOWN_PAYOUT: &str = "PAYOUT_UNKNOWN";

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PayoutStatus {
    /// `forward` is in flight.
    Sending,
    /// `forward` succeeded: the value left the source account.
    Sent,
    /// `forward` failed: the value never left.
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payout {
    pub id: u64,
    /// Module that started it; receives the result.
    pub module_id: String,
    /// Module reference (for example `<token_id>#<index>`).
    pub reference: String,
    pub source: AccountId,
    pub asset: String,
    pub amount_in: U128,
    pub deposit_address: AccountId,
    pub status: PayoutStatus,
    pub created_block: u64,
}

fn read<T: BorshDeserialize>(key: &[u8]) -> Option<T> {
    env::storage_read(key).map(|bytes| {
        T::try_from_slice(&bytes).unwrap_or_else(|_| env::panic_str("payout: corrupt state"))
    })
}

fn write<T: BorshSerialize>(key: &[u8], value: &T) {
    let bytes =
        near_sdk::borsh::to_vec(value).unwrap_or_else(|_| env::panic_str("payout: serialize"));
    env::storage_write(key, &bytes);
}

fn payout_key(id: u64) -> Vec<u8> {
    [PREFIX_PAYOUT, &id.to_le_bytes()].concat()
}

pub fn relayers() -> Vec<AccountId> {
    read(KEY_RELAYERS).unwrap_or_default()
}

/// Panics `PAYOUT_NOT_RELAYER` unless the predecessor is an allow-listed payout relayer.
pub fn require_relayer() {
    let caller = env::predecessor_account_id();
    require!(relayers().contains(&caller), ERR_NOT_RELAYER);
}

pub fn get(id: u64) -> Option<Payout> {
    read(&payout_key(id))
}

pub(crate) fn save(payout: &Payout) {
    write(&payout_key(payout.id), payout);
}

fn emit(event: &str, data: serde_json::Value) {
    let payload = json!({
        "standard": crate::events::OPENRAIL_EVENT_STANDARD,
        "version": crate::events::OPENRAIL_EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
struct VaultForwardArgs {
    token_id: String,
    amount: String,
    receiver_id: AccountId,
    gas_tgas: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
struct OnPayoutArgs {
    payout_id: u64,
}

/// Starts a payout. Internal only: callable from enabled module code, never a contract method.
/// The calling module has already checked the relayer, the amount it reserved, and the locks.
pub(crate) fn payout_from(
    module_id: &str,
    reference: String,
    source: AccountId,
    asset: String,
    amount_in: U128,
    deposit_address: AccountId,
) -> u64 {
    require!(
        crate::modules::ENABLED.contains(&module_id),
        ERR_MODULE_NOT_ENABLED
    );
    require!(amount_in.0 > 0, ERR_ZERO_AMOUNT);
    let id: u64 = read(KEY_NEXT).unwrap_or(1);
    write(KEY_NEXT, &(id + 1));
    let payout = Payout {
        id,
        module_id: module_id.to_string(),
        reference,
        source: source.clone(),
        asset: asset.clone(),
        amount_in,
        deposit_address: deposit_address.clone(),
        status: PayoutStatus::Sending,
        created_block: env::block_height(),
    };
    save(&payout);

    let forward = serde_json::to_vec(&VaultForwardArgs {
        token_id: asset,
        amount: amount_in.0.to_string(),
        receiver_id: deposit_address,
        gas_tgas: PAYOUT_FORWARD_INNER_TGAS,
    })
    .unwrap_or_else(|_| env::panic_str("payout: serialize forward"));
    let sent = env::promise_create(
        source,
        "forward",
        &forward,
        NearToken::ZERO,
        GAS_FOR_PAYOUT_FORWARD,
    );
    let callback = serde_json::to_vec(&OnPayoutArgs { payout_id: id })
        .unwrap_or_else(|_| env::panic_str("payout: serialize callback"));
    let then = env::promise_then(
        sent,
        env::current_account_id(),
        "on_payout",
        &callback,
        NearToken::ZERO,
        GAS_FOR_ON_PAYOUT,
    );
    env::promise_return(then);

    emit(
        "payout_sent",
        json!({
            "payout_id": id,
            "module": payout.module_id,
            "ref": payout.reference,
            "source": payout.source,
            "asset": payout.asset,
            "amount_in": payout.amount_in,
            "deposit_address": payout.deposit_address,
        }),
    );
    id
}

/// Records the forward result and hands it to the module that started the payout.
pub(crate) fn handle_on_payout(contract: &mut Contract, payout_id: u64) {
    let mut payout = get(payout_id).unwrap_or_else(|| env::panic_str(ERR_UNKNOWN_PAYOUT));
    if payout.status != PayoutStatus::Sending {
        // A duplicate callback cannot happen on NEAR, but never apply a result twice.
        return;
    }
    let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 4096).is_ok();
    payout.status = if ok {
        PayoutStatus::Sent
    } else {
        PayoutStatus::Failed
    };
    save(&payout);
    emit(
        if ok {
            "payout_forwarded"
        } else {
            "payout_failed"
        },
        json!({ "payout_id": payout.id, "module": payout.module_id, "ref": payout.reference }),
    );
    dispatch_result(contract, &payout, ok);
}

#[allow(unused_variables)]
fn dispatch_result(contract: &mut Contract, payout: &Payout, ok: bool) {
    match payout.module_id.as_str() {
        #[cfg(feature = "settle")]
        "settle" => crate::modules::settle::on_payout_result(contract, payout, ok),
        _ => {}
    }
}

#[near]
impl Contract {
    /// Sets the payout relayers (the only callers of module methods that start payouts).
    ///
    /// Caller: root only.
    pub fn set_payout_relayers(&mut self, relayers: Vec<AccountId>) {
        self.assert_root_only();
        write(KEY_RELAYERS, &relayers);
        emit("payout_relayers_set", json!({ "relayers": relayers }));
    }

    pub fn payout_relayers(&self) -> Vec<AccountId> {
        relayers()
    }

    pub fn payout(&self, payout_id: u64) -> Option<Payout> {
        get(payout_id)
    }

    /// Callback after `forward` on the source account.
    #[private]
    pub fn on_payout(&mut self, payout_id: u64) {
        handle_on_payout(self, payout_id);
    }
}
