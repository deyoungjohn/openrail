//! Module: get paid on your chain (blueprint `modules/settle.md`).
//!
//! A business sets a settlement destination once. At booking, its share of each payment is held
//! in the claim account (`Leg::Hold`) instead of being paid to its NEAR Intents account; a payout
//! relayer then forwards it to a 1Click deposit address for the destination chain.
//!
//! D-S8: each held amount records the owner at booking; a later token transfer never changes who
//! is paid. State lives under the raw prefix `m:settle:` (deployed state layout unchanged).

use crate::hooks::{Booking, Hook};
use crate::modules::payout::{self, Payout};
use crate::types::{Claim, Leg, Lock};
use crate::{Contract, ContractExt};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId};

pub const MODULE_ID: &str = "settle";

/// Blocks a claim stays locked while a payout is out (reconcile and transfers wait). About 10
/// minutes; payouts take 0.3–0.6 min (K11). After this anyone may `clear_stale_lock`.
pub const PAYOUT_LOCK_BLOCKS: u64 = 600;
/// A refunded payout is retried once, then flagged to the business.
pub const MAX_RETRIES: u8 = 1;

pub const CHAINS: &[&str] = &[
    "base", "arbitrum", "optimism", "polygon", "solana", "ethereum", "near",
];
const REFUSED_CHAINS: &[&str] = &["bnb", "bsc", "binance"];

pub const ERR_CHAIN_REFUSED: &str =
    "SETTLE_CHAIN_REFUSED: BNB Chain is not quotable as a destination";
pub const ERR_CHAIN_UNKNOWN: &str = "SETTLE_CHAIN_UNKNOWN";
pub const ERR_ADDRESS: &str = "SETTLE_BAD_ADDRESS";
pub const ERR_NO_DESTINATION: &str = "SETTLE_NO_DESTINATION";
pub const ERR_NOT_HELD: &str = "SETTLE_NOT_HELD";
pub const ERR_AMOUNT: &str = "SETTLE_AMOUNT_EXCEEDS_HELD";
pub const ERR_NOT_IN_FLIGHT: &str = "NOT_IN_FLIGHT";
pub const ERR_LOCKED: &str = "SETTLE_CLAIM_LOCKED";
pub const ERR_ASSET_SHORT: &str = "SETTLE_HELD_ASSET_SHORT";
pub const ERR_REFUND: &str = "SETTLE_REFUND_EXCEEDS_SENT";
pub const ERR_NOT_OWNER: &str = "SETTLE_NOT_OWNER_AT_BOOKING";

const PREFIX_DESTINATION: &[u8] = b"m:settle:d:";
const PREFIX_HELD: &[u8] = b"m:settle:h:";

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Destination {
    pub chain: String,
    pub address: String,
    /// Below this net amount the core default applies (paid to the Intents account).
    pub min_amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HeldStatus {
    Held,
    /// A payout is out (forward in flight or awaiting the relayer's report).
    InFlight {
        payout_id: u64,
    },
    Settled {
        payout_id: u64,
        destination_tx: String,
    },
    /// Refunded after the retry; the business decides (`settle_release` pays its Intents account).
    Flagged {
        reason: String,
    },
    /// Paid to the owner-at-booking's NEAR Intents account instead.
    Released {
        payout_id: u64,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldEntry {
    /// Owner of the token when the payment was booked (D-S8).
    pub owner: AccountId,
    pub asset: String,
    pub amount: U128,
    pub status: HeldStatus,
    pub retries: u8,
    /// Destination used by the last payout (read at payout time).
    pub destination: Option<Destination>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum PayoutOutcome {
    Settled {
        destination_tx: String,
    },
    /// 1Click refunded `amount` to the claim account (`refundTo`).
    Refunded {
        amount: U128,
    },
}

fn read<T: BorshDeserialize>(key: &[u8]) -> Option<T> {
    env::storage_read(key).map(|bytes| {
        T::try_from_slice(&bytes).unwrap_or_else(|_| env::panic_str("settle: corrupt state"))
    })
}

fn write<T: BorshSerialize>(key: &[u8], value: &T) {
    let bytes =
        near_sdk::borsh::to_vec(value).unwrap_or_else(|_| env::panic_str("settle: serialize"));
    env::storage_write(key, &bytes);
}

fn destination_key(account: &AccountId) -> Vec<u8> {
    [PREFIX_DESTINATION, account.as_bytes()].concat()
}

fn held_key(token_id: &str) -> Vec<u8> {
    [PREFIX_HELD, token_id.as_bytes()].concat()
}

pub fn destination_of(account: &AccountId) -> Option<Destination> {
    read(&destination_key(account))
}

pub fn held_of(token_id: &str) -> Vec<HeldEntry> {
    read(&held_key(token_id)).unwrap_or_default()
}

fn save_held(token_id: &str, entries: &Vec<HeldEntry>) {
    write(&held_key(token_id), entries);
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

fn is_hex(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_base58(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_alphanumeric() && b != b'0' && b != b'O' && b != b'I' && b != b'l')
}

/// Checks the chain and the address format. Returns the normalised chain id.
pub fn validate_destination(chain: &str, address: &str) -> String {
    let chain = chain.trim().to_ascii_lowercase();
    if REFUSED_CHAINS.contains(&chain.as_str()) {
        env::panic_str(ERR_CHAIN_REFUSED);
    }
    if !CHAINS.contains(&chain.as_str()) {
        env::panic_str(ERR_CHAIN_UNKNOWN);
    }
    let ok = match chain.as_str() {
        "solana" => (32..=44).contains(&address.len()) && is_base58(address),
        "near" => address.parse::<AccountId>().is_ok(),
        _ => address.len() == 42 && address.starts_with("0x") && is_hex(&address[2..]),
    };
    require!(ok, ERR_ADDRESS);
    chain
}

/// The module's hook: holds the owner's share when the owner has a destination.
pub struct SettleHook;
pub static HOOK: SettleHook = SettleHook;

impl Hook for SettleHook {
    fn split_distribution(&self, claim: &Claim, net: U128) -> Vec<Leg> {
        match destination_of(&claim.owner_id) {
            Some(d) if net.0 > 0 && net.0 >= d.min_amount.0 => vec![Leg::Hold {
                module_id: MODULE_ID.to_string(),
                amount: net,
                asset: None,
            }],
            _ => vec![Leg::pay(claim.owner_id.clone(), net)],
        }
    }

    fn on_booked(&self, claim: &Claim, booking: &Booking) {
        let mut entries = held_of(&claim.token_id);
        let before = entries.len();
        for leg in &booking.legs {
            if let Leg::Hold {
                module_id,
                amount,
                asset: Some(asset),
            } = leg
            {
                if module_id == MODULE_ID && amount.0 > 0 {
                    entries.push(HeldEntry {
                        owner: claim.owner_id.clone(),
                        asset: asset.clone(),
                        amount: *amount,
                        status: HeldStatus::Held,
                        retries: 0,
                        destination: None,
                    });
                }
            }
        }
        if entries.len() != before {
            save_held(&claim.token_id, &entries);
            for (index, entry) in entries.iter().enumerate().skip(before) {
                emit(
                    "settle_held",
                    json!({
                        "token_id": claim.token_id,
                        "index": index,
                        "owner": entry.owner,
                        "asset": entry.asset,
                        "amount": entry.amount,
                    }),
                );
            }
        }
    }
}

fn reference(token_id: &str, index: u32) -> String {
    format!("{token_id}#{index}")
}

fn parse_reference(reference: &str) -> (String, u32) {
    let (token, index) = reference
        .rsplit_once('#')
        .unwrap_or_else(|| env::panic_str("settle: bad payout reference"));
    (
        token.to_string(),
        index
            .parse()
            .unwrap_or_else(|_| env::panic_str("settle: bad payout reference")),
    )
}

fn lock_claim(contract: &mut Contract, token_id: &str) -> AccountId {
    let claim = contract
        .claims
        .get_mut(token_id)
        .unwrap_or_else(|| env::panic_str("claim not found"));
    require!(claim.lock.allows_transfer(), ERR_LOCKED);
    claim.lock = Lock::Module {
        id: MODULE_ID.to_string(),
        until: env::block_height() + PAYOUT_LOCK_BLOCKS,
    };
    claim.claim_account.clone()
}

fn unlock_claim(contract: &mut Contract, token_id: &str) {
    if let Some(claim) = contract.claims.get_mut(token_id) {
        if matches!(&claim.lock, Lock::Module { id, .. } if id == MODULE_ID) {
            claim.lock = Lock::None;
        }
    }
}

fn adjust_last_seen(contract: &mut Contract, token_id: &str, asset: &str, add: u128, sub: u128) {
    if let Some(claim) = contract.claims.get_mut(token_id) {
        let current = claim
            .last_seen_balance
            .get(asset)
            .copied()
            .unwrap_or(U128(0))
            .0;
        claim.last_seen_balance.insert(
            asset.to_string(),
            U128(current.saturating_add(add).saturating_sub(sub)),
        );
    }
}

/// Starts a payout of (part of) a held entry. Shared by `settle_payout` and `settle_release`.
fn start(
    contract: &mut Contract,
    token_id: &str,
    index: u32,
    amount_in: U128,
    deposit_address: AccountId,
    destination: Option<Destination>,
) -> u64 {
    let mut entries = held_of(token_id);
    let i = index as usize;
    let entry = entries
        .get(i)
        .cloned()
        .unwrap_or_else(|| env::panic_str(ERR_NOT_HELD));
    require!(
        matches!(entry.status, HeldStatus::Held | HeldStatus::Flagged { .. }),
        ERR_NOT_HELD
    );
    require!(amount_in.0 > 0 && amount_in.0 <= entry.amount.0, ERR_AMOUNT);
    {
        let claim = contract
            .claims
            .get(token_id)
            .unwrap_or_else(|| env::panic_str("claim not found"));
        let seen = claim
            .last_seen_balance
            .get(&entry.asset)
            .copied()
            .unwrap_or(U128(0))
            .0;
        require!(seen >= amount_in.0, ERR_ASSET_SHORT);
    }
    let source = lock_claim(contract, token_id);

    // A partial payout leaves the rest held as a new entry for the same owner (D-S8).
    if amount_in.0 < entry.amount.0 {
        entries.push(HeldEntry {
            amount: U128(entry.amount.0 - amount_in.0),
            status: HeldStatus::Held,
            destination: None,
            ..entry.clone()
        });
    }
    let payout_id = payout::payout_from(
        MODULE_ID,
        reference(token_id, index),
        source,
        entry.asset.clone(),
        amount_in,
        deposit_address,
    );
    let slot = &mut entries[i];
    slot.amount = amount_in;
    slot.status = HeldStatus::InFlight { payout_id };
    slot.destination = destination;
    save_held(token_id, &entries);
    payout_id
}

/// Called by the payout component when `forward` resolves.
pub(crate) fn on_payout_result(contract: &mut Contract, payout: &Payout, ok: bool) {
    let (token_id, index) = parse_reference(&payout.reference);
    let mut entries = held_of(&token_id);
    let Some(entry) = entries.get_mut(index as usize) else {
        return;
    };
    if entry.status
        != (HeldStatus::InFlight {
            payout_id: payout.id,
        })
    {
        return;
    }
    if ok {
        // The value left the claim account: stop counting it as seen, so the next reconcile
        // neither books a phantom payment nor raises an anomaly.
        adjust_last_seen(contract, &token_id, &payout.asset, 0, payout.amount_in.0);
        if entry.destination.is_none() {
            // A release to the owner's NEAR Intents account is final once forwarded.
            entry.status = HeldStatus::Released {
                payout_id: payout.id,
            };
            save_held(&token_id, &entries);
            unlock_claim(contract, &token_id);
        } else {
            // The lock stays until the relayer reports the destination result (or it expires),
            // so a refund arriving meanwhile is not booked as a new payment.
            save_held(&token_id, &entries);
        }
    } else {
        // The value never left: hold it again.
        entry.status = HeldStatus::Held;
        save_held(&token_id, &entries);
        unlock_claim(contract, &token_id);
    }
}

#[near]
impl Contract {
    /// Sets where this account wants to be paid. Caller: the business itself (its own wallet).
    pub fn set_settlement(&mut self, chain: String, address: String, min_amount: U128) {
        let business = env::predecessor_account_id();
        let chain = validate_destination(&chain, &address);
        let destination = Destination {
            chain,
            address,
            min_amount,
        };
        write(&destination_key(&business), &destination);
        emit(
            "settle_destination_set",
            json!({ "business": business, "destination": destination }),
        );
    }

    /// Removes the destination: later bookings pay the NEAR Intents account again.
    pub fn clear_settlement(&mut self) {
        let business = env::predecessor_account_id();
        env::storage_remove(&destination_key(&business));
        emit(
            "settle_destination_cleared",
            json!({ "business": business }),
        );
    }

    pub fn settlement_of(&self, account_id: AccountId) -> Option<Destination> {
        destination_of(&account_id)
    }

    pub fn settle_held(&self, token_id: String) -> Vec<HeldEntry> {
        held_of(&token_id)
    }

    /// Forwards a held amount to a 1Click deposit address for the owner-at-booking's destination.
    ///
    /// Caller: an allow-listed payout relayer. The service has checked that the quote's
    /// recipient and asset equal the destination before calling.
    pub fn settle_payout(
        &mut self,
        token_id: String,
        index: u32,
        deposit_address: AccountId,
        amount_in: U128,
    ) -> u64 {
        payout::require_relayer();
        let entry = held_of(&token_id)
            .get(index as usize)
            .cloned()
            .unwrap_or_else(|| env::panic_str(ERR_NOT_HELD));
        require!(entry.status == HeldStatus::Held, ERR_NOT_HELD);
        let destination =
            destination_of(&entry.owner).unwrap_or_else(|| env::panic_str(ERR_NO_DESTINATION));
        let payout_id = start(
            self,
            &token_id,
            index,
            amount_in,
            deposit_address.clone(),
            Some(destination.clone()),
        );
        emit(
            "settle_sent",
            json!({
                "token_id": token_id,
                "index": index,
                "payout_id": payout_id,
                "owner": entry.owner,
                "amount_in": amount_in,
                "deposit_address": deposit_address,
                "chain": destination.chain,
                "address": destination.address,
            }),
        );
        payout_id
    }

    /// The relayer reports what happened at the destination.
    ///
    /// Panics `NOT_IN_FLIGHT` unless that payout is out for that entry.
    pub fn report_payout(
        &mut self,
        token_id: String,
        index: u32,
        payout_id: u64,
        outcome: PayoutOutcome,
    ) {
        payout::require_relayer();
        let mut entries = held_of(&token_id);
        let entry = entries
            .get_mut(index as usize)
            .unwrap_or_else(|| env::panic_str(ERR_NOT_IN_FLIGHT));
        require!(
            entry.status == (HeldStatus::InFlight { payout_id }),
            ERR_NOT_IN_FLIGHT
        );
        let sent = payout::get(payout_id).unwrap_or_else(|| env::panic_str(ERR_NOT_IN_FLIGHT));
        require!(sent.status == payout::PayoutStatus::Sent, ERR_NOT_IN_FLIGHT);
        let asset = entry.asset.clone();
        match outcome {
            PayoutOutcome::Settled { destination_tx } => {
                require!(
                    !destination_tx.is_empty() && destination_tx.len() <= 128,
                    "SETTLE_BAD_TX"
                );
                entry.status = HeldStatus::Settled {
                    payout_id,
                    destination_tx: destination_tx.clone(),
                };
                emit(
                    "settle_settled",
                    json!({ "token_id": token_id, "index": index, "payout_id": payout_id, "destination_tx": destination_tx }),
                );
            }
            PayoutOutcome::Refunded { amount } => {
                require!(amount.0 <= sent.amount_in.0, ERR_REFUND);
                // The refund is back in the claim account: count it as seen again and hold it.
                entry.amount = amount;
                if entry.retries < MAX_RETRIES {
                    entry.retries += 1;
                    entry.status = HeldStatus::Held;
                } else {
                    entry.status = HeldStatus::Flagged {
                        reason: "refunded twice".to_string(),
                    };
                }
                let flagged = matches!(entry.status, HeldStatus::Flagged { .. });
                save_held(&token_id, &entries);
                adjust_last_seen(self, &token_id, &asset, amount.0, 0);
                unlock_claim(self, &token_id);
                emit(
                    "settle_refunded",
                    json!({ "token_id": token_id, "index": index, "payout_id": payout_id, "amount": amount, "flagged": flagged }),
                );
                return;
            }
        }
        save_held(&token_id, &entries);
        unlock_claim(self, &token_id);
    }

    /// Pays a held or flagged amount to the owner-at-booking's NEAR Intents account instead.
    ///
    /// Caller: that owner (recorded at booking), for example after clearing its destination.
    pub fn settle_release(&mut self, token_id: String, index: u32) -> u64 {
        let entry = held_of(&token_id)
            .get(index as usize)
            .cloned()
            .unwrap_or_else(|| env::panic_str(ERR_NOT_HELD));
        require!(env::predecessor_account_id() == entry.owner, ERR_NOT_OWNER);
        let payout_id = start(
            self,
            &token_id,
            index,
            entry.amount,
            entry.owner.clone(),
            None,
        );
        let mut entries = held_of(&token_id);
        entries[index as usize].status = HeldStatus::InFlight { payout_id };
        save_held(&token_id, &entries);
        emit(
            "settle_release_sent",
            json!({ "token_id": token_id, "index": index, "payout_id": payout_id, "owner": entry.owner }),
        );
        payout_id
    }
}

#[cfg(test)]
mod tests;
