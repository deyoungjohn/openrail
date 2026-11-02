//! Pure-Rust domain types for the Openrail reference model (Blueprint 2.1).
//!
//! No NEAR types or SDK dependencies: all types use standard Rust types and serde.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

/// Account identifier (pure string, e.g. "alice.near").
pub type AccountId = String;

/// Token identifier (e.g. "c-1" or Intents token ID "nep141:...").
pub type TokenId = String;

/// 0x-prefixed 32-byte hex type.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Hex32(pub [u8; 32]);

impl Hex32 {
    pub const fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn from_hex(s: &str) -> Result<Self, String> {
        let s = s
            .strip_prefix("0x")
            .or_else(|| s.strip_prefix("0X"))
            .ok_or_else(|| "missing 0x prefix on hex string".to_string())?;
        if s.len() != 64 {
            return Err(format!("expected 64 hex chars, got {}", s.len()));
        }
        let mut arr = [0u8; 32];
        for i in 0..32 {
            arr[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
                .map_err(|e| format!("invalid hex char at pos {}: {}", i * 2, e))?;
        }
        Ok(Self(arr))
    }

    pub fn to_hex(&self) -> String {
        let mut s = String::with_capacity(66);
        s.push_str("0x");
        for b in &self.0 {
            use std::fmt::Write;
            write!(&mut s, "{:02x}", b).unwrap();
        }
        s
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for Hex32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Hex32({})", self.to_hex())
    }
}

impl fmt::Display for Hex32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_hex())
    }
}

impl From<[u8; 32]> for Hex32 {
    fn from(b: [u8; 32]) -> Self {
        Self(b)
    }
}

impl From<Hex32> for [u8; 32] {
    fn from(h: Hex32) -> Self {
        h.0
    }
}

impl Serialize for Hex32 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Hex32 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Self::from_hex(&s).map_err(serde::de::Error::custom)
    }
}

/// 0x-prefixed 20-byte EVM address.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Hex20(pub [u8; 20]);

impl Hex20 {
    pub const fn new(bytes: [u8; 20]) -> Self {
        Self(bytes)
    }

    pub fn from_hex(s: &str) -> Result<Self, String> {
        let s = s
            .strip_prefix("0x")
            .or_else(|| s.strip_prefix("0X"))
            .ok_or_else(|| "missing 0x prefix on hex string".to_string())?;
        if s.len() != 40 {
            return Err(format!("expected 40 hex chars, got {}", s.len()));
        }
        let mut arr = [0u8; 20];
        for i in 0..20 {
            arr[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
                .map_err(|e| format!("invalid hex char at pos {}: {}", i * 2, e))?;
        }
        Ok(Self(arr))
    }

    pub fn to_hex(&self) -> String {
        let mut s = String::with_capacity(42);
        s.push_str("0x");
        for b in &self.0 {
            use std::fmt::Write;
            write!(&mut s, "{:02x}", b).unwrap();
        }
        s
    }

    pub fn as_bytes(&self) -> &[u8; 20] {
        &self.0
    }
}

impl fmt::Debug for Hex20 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Hex20({})", self.to_hex())
    }
}

impl fmt::Display for Hex20 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_hex())
    }
}

impl From<[u8; 20]> for Hex20 {
    fn from(b: [u8; 20]) -> Self {
        Self(b)
    }
}

impl From<Hex20> for [u8; 20] {
    fn from(h: Hex20) -> Self {
        h.0
    }
}

impl Serialize for Hex20 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Hex20 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Self::from_hex(&s).map_err(serde::de::Error::custom)
    }
}

/// The Debtor on a claim (Blueprint 2.1).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Debtor {
    Evm(Hex20),
    Near(AccountId),
}

/// Acknowledgment scheme used by debtor (Blueprint 2.1, 2.7).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AckScheme {
    Evm { chain_id: u64, signer: Hex20 },
    Near { account: AccountId },
}

/// Acknowledgment record on a claim (Blueprint 2.1).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ack {
    pub scheme: AckScheme,
    pub block: u64,
}

/// Lifecycle status of a claim (Blueprint 2.1, 2.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Hash)]
pub enum Status {
    Issued,
    PartiallyPaid,
    Paid,
    Cancelled,
    Closed,
}

impl Status {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Status::Cancelled | Status::Closed)
    }
}

/// Concurrency lock on a claim (Blueprint 2.1, 2.3).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Lock {
    #[default]
    None,
    Reconciling {
        since: u64,
    },
    TransferWindow {
        until: u64,
    },
    Module {
        id: String,
        until: u64,
    },
}

impl Lock {
    pub fn is_none(&self) -> bool {
        matches!(self, Lock::None)
    }

    pub fn allows_transfer(&self) -> bool {
        matches!(self, Lock::None | Lock::TransferWindow { .. })
    }
}

/// Distribution leg for net payment value (Blueprint 1.4, 2.1, 2.5).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Leg {
    Pay {
        receiver: AccountId,
        amount: u128,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        asset: Option<TokenId>,
    },
    Hold {
        module_id: String,
        amount: u128,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        asset: Option<TokenId>,
    },
}

impl Leg {
    pub fn pay(receiver: AccountId, amount: u128) -> Self {
        Self::Pay {
            receiver,
            amount,
            asset: None,
        }
    }

    pub fn pay_with_asset(receiver: AccountId, amount: u128, asset: TokenId) -> Self {
        Self::Pay {
            receiver,
            amount,
            asset: Some(asset),
        }
    }

    pub fn hold(module_id: String, amount: u128) -> Self {
        Self::Hold {
            module_id,
            amount,
            asset: None,
        }
    }

    pub fn amount(&self) -> u128 {
        match self {
            Self::Pay { amount, .. } => *amount,
            Self::Hold { amount, .. } => *amount,
        }
    }

    pub fn receiver(&self) -> Option<&AccountId> {
        match self {
            Self::Pay { receiver, .. } => Some(receiver),
            Self::Hold { .. } => None,
        }
    }

    pub fn asset(&self) -> Option<&TokenId> {
        match self {
            Self::Pay { asset, .. } => asset.as_ref(),
            Self::Hold { asset, .. } => asset.as_ref(),
        }
    }

    pub fn set_asset(&mut self, asset_id: TokenId) {
        match self {
            Self::Pay { asset, .. } => *asset = Some(asset_id),
            Self::Hold { asset, .. } => *asset = Some(asset_id),
        }
    }
}

/// Payment log quote entry (Blueprint 2.1).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quote {
    pub quote_id: String,
    pub deposit_address: String,
    pub deadline_requested: u64,
    pub refund_to: String,
    pub route_id: String,
}

/// Debtor co-signature for cancellation (Blueprint 2.2 line 65).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DebtorCosig {
    Evm { chain_id: u64, sig: Vec<u8> },
    Near,
}

/// Global contract configuration (Blueprint 2.1).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    pub settlement_assets: Vec<TokenId>,
    pub vault_code_hash: Hex32,
    pub fee_account: AccountId,
    pub watchers: Vec<AccountId>,
    pub quote_writers: Vec<AccountId>,
    pub issuers: Vec<AccountId>,
    pub issue_paused: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            settlement_assets: vec![
                "nep141:usdc.near".to_string(),
                "nep141:usdc.base".to_string(),
                "nep141:usdc.arb".to_string(),
                "nep141:usdc.eth".to_string(),
            ],
            vault_code_hash: Hex32::default(),
            fee_account: "fee.openrail.near".to_string(),
            watchers: vec!["watcher.openrail.near".to_string()],
            quote_writers: vec!["relayer.openrail.near".to_string()],
            issuers: vec!["issuer.openrail.near".to_string()],
            issue_paused: false,
        }
    }
}

/// Rules associated with a claim kind (Blueprint 2.1, 2.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KindRules {
    pub ack_required_for_sale: bool,
    pub sellable: bool,
    pub debtor_optional: bool,
    pub quote_deadline: u64,
}

impl KindRules {
    /// Standard invoice kind rules (kind == 0).
    pub fn invoice() -> Self {
        Self {
            ack_required_for_sale: true,
            sellable: true,
            debtor_optional: false,
            quote_deadline: 72 * 3600,
        }
    }
}

/// The core `Claim` record (Blueprint 2.1).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claim {
    pub token_id: String,
    pub kind: u8,
    pub issuer_id: AccountId,
    pub owner_id: AccountId,
    pub claim_account: AccountId,
    pub debtor: Option<Debtor>,
    pub terms_hash: Hex32,
    pub amount_due: u128,
    pub due_date: u64,
    pub ack: Option<Ack>,
    pub status: Status,
    pub lock: Lock,
    pub settlement_assets: Vec<TokenId>,
    pub booked_total: u128,
    pub distributed_total: u128,
    pub fee_total: u128,
    pub surplus: u128,
    pub credit_total: u128,
    pub credit_source: Option<u8>,
    pub last_seen_balance: HashMap<TokenId, u128>,
    pub undistributed: Vec<Leg>,
    pub assignment_doc_hash: Option<Hex32>,
    pub created_block: u64,
}

impl Claim {
    /// Effective booked value that reduces outstanding debt: `booked_total - surplus`.
    pub fn effective_booked(&self) -> u128 {
        self.booked_total.saturating_sub(self.surplus)
    }

    /// Effective payment plus credit: `booked_total - surplus + credit_total`.
    pub fn effective_payment(&self) -> u128 {
        self.effective_booked().saturating_add(self.credit_total)
    }

    /// Outstanding amount due: `amount_due - (booked_total - surplus) - credit_total`.
    pub fn outstanding(&self) -> u128 {
        self.amount_due.saturating_sub(self.effective_payment())
    }

    /// True if fully satisfied under the paid rule (Blueprint 2.3).
    pub fn is_paid(&self) -> bool {
        self.effective_payment() == self.amount_due
    }

    /// True if partially satisfied under the paid rule (Blueprint 2.3).
    pub fn is_partially_paid(&self) -> bool {
        let eff = self.effective_payment();
        eff > 0 && eff < self.amount_due
    }

    /// Updates status strictly obeying the paid rule (Blueprint 2.3).
    ///
    /// Terminal states (Cancelled, Closed) and Paid are never demoted by bookings.
    pub fn update_status_paid_rule(&mut self) {
        if self.status.is_terminal() || self.status == Status::Paid {
            return;
        }
        let eff = self.effective_payment();
        if eff == self.amount_due {
            self.status = Status::Paid;
        } else if eff > 0 {
            self.status = Status::PartiallyPaid;
        } else {
            self.status = Status::Issued;
        }
    }
}

/// Booking information passed to hook callbacks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookingInfo {
    pub payment: u128,
    pub surplus_part: u128,
    pub fee: u128,
    pub credit: u128,
    pub legs: Vec<Leg>,
}
