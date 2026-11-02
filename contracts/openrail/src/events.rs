//! NEP-297 Event definitions and emitters for Openrail (Blueprint 2.9).
//!
//! Standard: `openrail`, version: `1.0.0`.
//! NFT standard: `nep171`, version: `1.0.0`.

use crate::types::{AckScheme, Debtor, Hex32, Leg, Lock, TokenId};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{near, AccountId};

pub const OPENRAIL_EVENT_STANDARD: &str = "openrail";
pub const OPENRAIL_EVENT_VERSION: &str = "1.0.0";
pub const NEP171_EVENT_STANDARD: &str = "nep171";
pub const NEP171_EVENT_VERSION: &str = "1.0.0";

fn emit_event(standard: &str, version: &str, event: &str, data: serde_json::Value) {
    let payload = json!({
        "standard": standard,
        "version": version,
        "event": event,
        "data": [data]
    });
    near_sdk::env::log_str(&format!("EVENT_JSON:{}", payload));
}

// ──────────────────────────────────────────────
// Core Events (Blueprint 2.9)
// ──────────────────────────────────────────────

/// Emitted when a new claim is issued and token minted.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssueEvent {
    pub token_id: String,
    pub kind: u8,
    pub issuer_id: AccountId,
    pub owner_id: AccountId,
    pub debtor: Option<Debtor>,
    pub terms_hash: Hex32,
    pub amount_due: U128,
    pub due_date: u64,
}

impl IssueEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "issue",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when debtor acknowledgment is recorded.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AckEvent {
    pub token_id: String,
    pub scheme: AckScheme,
    pub block: u64,
}

impl AckEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "ack",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when a payment quote is logged by a quote writer.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuoteLoggedEvent {
    pub token_id: String,
    pub quote_id: String,
    pub deposit_address: String,
    pub deadline_requested: u64,
    pub refund_to: String,
    pub route_id: String,
}

impl QuoteLoggedEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "quote_logged",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when a payment is booked in the reconcile callback.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookedEvent {
    pub token_id: String,
    pub payment: U128,
    pub surplus: U128,
    pub fee: U128,
    pub credit: U128,
    pub legs: Vec<Leg>,
}

impl BookedEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "booked",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when a distribution leg succeeds.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DistributedEvent {
    pub token_id: String,
    pub leg: Leg,
}

impl DistributedEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "distributed",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when a distribution leg fails and is queued to `undistributed`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DistributionFailedEvent {
    pub token_id: String,
    pub leg: Leg,
    pub reason: Option<String>,
}

impl DistributionFailedEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "distribution_failed",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when surplus payment is booked to a claim.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SurplusEvent {
    pub token_id: String,
    pub amount: U128,
}

impl SurplusEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "surplus",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when accumulated surplus is released to claim owner.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SurplusReleasedEvent {
    pub token_id: String,
    pub amount: U128,
    pub receiver_id: AccountId,
}

impl SurplusReleasedEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "surplus_released",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when a non-settlement asset deposit is detected.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnmatchedEvent {
    pub token_id: String,
    pub asset: TokenId,
    pub amount: U128,
}

impl UnmatchedEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "unmatched",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when a balance decreases unexpectedly.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnomalyEvent {
    pub token_id: String,
    pub asset: TokenId,
    pub balance: U128,
    pub last_seen: U128,
}

impl AnomalyEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "anomaly",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when a transfer window lock is opened.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransferWindowEvent {
    pub token_id: String,
    pub until: u64,
}

impl TransferWindowEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "transfer_window",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when an invoice is cancelled.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CancelEvent {
    pub token_id: String,
    pub reason: Option<String>,
}

impl CancelEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "cancel",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when a paid claim is formally closed.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloseEvent {
    pub token_id: String,
}

impl CloseEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "close",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when a partially paid invoice is closed with writeoff shortfall.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteoffEvent {
    pub token_id: String,
    pub shortfall: U128,
}

impl WriteoffEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "writeoff",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when a stale lock is cleared by automated pump or caller.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockClearedEvent {
    pub token_id: String,
    pub cleared_lock: Lock,
}

impl LockClearedEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "lock_cleared",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when contract admin configuration parameters change.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigChangedEvent {
    pub parameter: String,
    pub new_value: String,
}

impl ConfigChangedEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "config_changed",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// Emitted when a reconcile promise callback encounters an error.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReconcileFailedEvent {
    pub token_id: String,
    pub reason: String,
}

impl ReconcileFailedEvent {
    pub fn emit(&self) {
        emit_event(
            OPENRAIL_EVENT_STANDARD,
            OPENRAIL_EVENT_VERSION,
            "reconcile_failed",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

// ──────────────────────────────────────────────
// NEP-171 Events
// ──────────────────────────────────────────────

/// NEP-171 mint event.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NftMintEvent {
    pub owner_id: AccountId,
    pub token_ids: Vec<String>,
    pub memo: Option<String>,
}

impl NftMintEvent {
    pub fn emit(&self) {
        emit_event(
            NEP171_EVENT_STANDARD,
            NEP171_EVENT_VERSION,
            "nft_mint",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}

/// NEP-171 transfer event.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NftTransferEvent {
    pub authorized_id: Option<AccountId>,
    pub old_owner_id: AccountId,
    pub new_owner_id: AccountId,
    pub token_ids: Vec<String>,
    pub memo: Option<String>,
}

impl NftTransferEvent {
    pub fn emit(&self) {
        emit_event(
            NEP171_EVENT_STANDARD,
            NEP171_EVENT_VERSION,
            "nft_transfer",
            serde_json::to_value(self).expect("failed to serialize event"),
        );
    }
}
