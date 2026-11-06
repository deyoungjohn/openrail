//! Core types for the Openrail protocol (Blueprint 2.1).
//!
//! All types derive Borsh and JSON serialization using `near_sdk`.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};
use std::collections::HashMap;
use std::fmt;
use std::ops::Deref;

/// Intents token identifier (e.g. `nep141:...` or `nep245:...`).
///
/// Contains `:` delimiters and is not a valid NEAR AccountId.
pub type TokenId = String;

// ──────────────────────────────────────────────
// Hex Serialization Helpers & Newtypes
// ──────────────────────────────────────────────

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for &b in bytes {
        use std::fmt::Write;
        write!(&mut s, "{:02x}", b).unwrap();
    }
    s
}

fn from_hex(s: &str) -> Result<Vec<u8>, String> {
    let s = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .ok_or_else(|| "missing 0x prefix on hex string".to_string())?;
    if s.len() % 2 != 0 {
        return Err("odd hex string length".to_string());
    }
    let mut bytes = Vec::with_capacity(s.len() / 2);
    for i in (0..s.len()).step_by(2) {
        let byte = u8::from_str_radix(&s[i..i + 2], 16)
            .map_err(|e| format!("invalid hex character at position {}: {}", i, e))?;
        bytes.push(byte);
    }
    Ok(bytes)
}

fn from_hex_fixed<const N: usize>(s: &str) -> Result<[u8; N], String> {
    let bytes = from_hex(s)?;
    if bytes.len() != N {
        return Err(format!(
            "expected {} bytes ({} hex chars), got {}",
            N,
            N * 2,
            bytes.len()
        ));
    }
    let mut arr = [0u8; N];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

/// 0x-prefixed 32-byte hex string in JSON; raw 32 bytes in Borsh.
#[near(serializers = [json, borsh])]
#[serde(into = "String", try_from = "String")]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Hex32(pub [u8; 32]);

impl Hex32 {
    pub const fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn from_hex(s: &str) -> Result<Self, String> {
        from_hex_fixed::<32>(s).map(Self)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl Deref for Hex32 {
    type Target = [u8; 32];
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl AsRef<[u8; 32]> for Hex32 {
    fn as_ref(&self) -> &[u8; 32] {
        &self.0
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

impl From<Hex32> for String {
    fn from(h: Hex32) -> Self {
        to_hex(&h.0)
    }
}

impl TryFrom<String> for Hex32 {
    type Error = String;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        Self::from_hex(&s)
    }
}

impl TryFrom<&str> for Hex32 {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        Self::from_hex(s)
    }
}

impl fmt::Debug for Hex32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Hex32({})", to_hex(&self.0))
    }
}

impl fmt::Display for Hex32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", to_hex(&self.0))
    }
}

/// 0x-prefixed 20-byte EVM address hex string in JSON; raw 20 bytes in Borsh.
#[near(serializers = [json, borsh])]
#[serde(into = "String", try_from = "String")]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Hex20(pub [u8; 20]);

impl Hex20 {
    pub const fn new(bytes: [u8; 20]) -> Self {
        Self(bytes)
    }

    pub fn from_hex(s: &str) -> Result<Self, String> {
        from_hex_fixed::<20>(s).map(Self)
    }

    pub fn as_bytes(&self) -> &[u8; 20] {
        &self.0
    }
}

impl Deref for Hex20 {
    type Target = [u8; 20];
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl AsRef<[u8; 20]> for Hex20 {
    fn as_ref(&self) -> &[u8; 20] {
        &self.0
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

impl From<Hex20> for String {
    fn from(h: Hex20) -> Self {
        to_hex(&h.0)
    }
}

impl TryFrom<String> for Hex20 {
    type Error = String;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        Self::from_hex(&s)
    }
}

impl TryFrom<&str> for Hex20 {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        Self::from_hex(s)
    }
}

impl fmt::Debug for Hex20 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Hex20({})", to_hex(&self.0))
    }
}

impl fmt::Display for Hex20 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", to_hex(&self.0))
    }
}

/// 0x-prefixed hex string of variable byte length in JSON; raw byte vector in Borsh.
#[near(serializers = [json, borsh])]
#[serde(into = "String", try_from = "String")]
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct HexBytes(pub Vec<u8>);

impl HexBytes {
    pub const fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub fn from_hex(s: &str) -> Result<Self, String> {
        from_hex(s).map(Self)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl Deref for HexBytes {
    type Target = [u8];
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl AsRef<[u8]> for HexBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl From<Vec<u8>> for HexBytes {
    fn from(v: Vec<u8>) -> Self {
        Self(v)
    }
}

impl From<&[u8]> for HexBytes {
    fn from(s: &[u8]) -> Self {
        Self(s.to_vec())
    }
}

impl From<HexBytes> for Vec<u8> {
    fn from(h: HexBytes) -> Self {
        h.0
    }
}

impl From<HexBytes> for String {
    fn from(h: HexBytes) -> Self {
        to_hex(&h.0)
    }
}

impl TryFrom<String> for HexBytes {
    type Error = String;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        Self::from_hex(&s)
    }
}

impl TryFrom<&str> for HexBytes {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        Self::from_hex(s)
    }
}

impl fmt::Debug for HexBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "HexBytes({})", to_hex(&self.0))
    }
}

impl fmt::Display for HexBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", to_hex(&self.0))
    }
}

// ──────────────────────────────────────────────
// Domain Types (Blueprint 2.1)
// ──────────────────────────────────────────────

/// The Debtor on a claim (Blueprint 2.1).
///
/// Written by `issue`, immutable thereafter.
/// Can only be `None` if `kind_rules(kind).debtor_optional` permits.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Debtor {
    /// 20-byte EVM address (0x-prefixed hex in JSON).
    Evm(Hex20),
    /// NEAR account identifier of the debtor.
    Near(AccountId),
}

/// Acknowledgment scheme used by the debtor (Blueprint 2.1, 2.7).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AckScheme {
    /// EIP-712 signed typed data on an accepted EVM chain.
    Evm { chain_id: u64, signer: Hex20 },
    /// Direct call or NEP-366 meta-transaction by NEAR account.
    Near { account: AccountId },
}

/// The Acknowledgment record on a claim (Blueprint 2.1).
///
/// Write-once: written exclusively by `acknowledge_near` or `acknowledge_evm`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ack {
    /// The scheme and identity that acknowledged the claim.
    pub scheme: AckScheme,
    /// Block height at which acknowledgment occurred.
    pub block: u64,
}

/// Lifecycle status of a claim (Blueprint 2.1, 2.3).
///
/// Transitions strictly obey the state machine in Blueprint 2.3.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Minted and active; outstanding == amount_due.
    Issued,
    /// Partially booked; 0 < booked_total - surplus + credit_total < amount_due.
    PartiallyPaid,
    /// Fully booked; booked_total - surplus + credit_total == amount_due.
    Paid,
    /// Cancelled before any payment or credit was booked.
    Cancelled,
    /// Terminal closure (standard close or close_writeoff shortfall).
    Closed,
}

impl Status {
    /// Returns true if this status is terminal (cannot transition further).
    pub fn is_terminal(&self) -> bool {
        matches!(self, Status::Cancelled | Status::Closed)
    }
}

/// Default transfer window duration in blocks (Blueprint 2.3).
pub const TRANSFER_WINDOW_BLOCKS: u64 = 1_800;

/// Concurrency lock on a claim (Blueprint 2.1, 2.3).
///
/// Enforces safety and serial execution across asynchronous callbacks.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Lock {
    /// No lock active; operations allowed.
    #[default]
    None,
    /// Active reconcile callback in flight; blocks transfers, cancels, closes, releases.
    Reconciling { since: u64 },
    /// Transfer window opened by `prepare_transfer`; blocks actions that start money moving.
    TransferWindow { until: u64 },
    /// Module-defined lock; bounded until block height.
    Module { id: String, until: u64 },
}

impl Lock {
    /// Returns true if no lock is held.
    pub fn is_none(&self) -> bool {
        matches!(self, Lock::None)
    }

    /// Returns true if this lock permits transfer / reconcile actions.
    pub fn allows_transfer(&self) -> bool {
        matches!(self, Lock::None | Lock::TransferWindow { .. })
    }
}

/// Distribution leg for net payment value (Blueprint 1.4, 2.1, 2.5).
///
/// Fixed at booking time (D-S8 invariant: receiver is recorded and immutable).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Leg {
    /// Payment forwarded to an external account (owner, beneficiary, or fee account).
    Pay {
        receiver: AccountId,
        amount: U128,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        asset: Option<TokenId>,
    },
    /// Retained in the claim account for delayed payout by an enabled module.
    Hold {
        module_id: String,
        amount: U128,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        asset: Option<TokenId>,
    },
}

impl Leg {
    /// Constructs a payment leg without an assigned asset.
    pub fn pay(receiver: AccountId, amount: U128) -> Self {
        Self::Pay {
            receiver,
            amount,
            asset: None,
        }
    }

    /// Constructs a payment leg with an assigned settlement asset.
    pub fn pay_with_asset(receiver: AccountId, amount: U128, asset: TokenId) -> Self {
        Self::Pay {
            receiver,
            amount,
            asset: Some(asset),
        }
    }

    /// Constructs a module hold leg.
    pub fn hold(module_id: String, amount: U128) -> Self {
        Self::Hold {
            module_id,
            amount,
            asset: None,
        }
    }

    /// Returns the leg amount.
    pub fn amount(&self) -> U128 {
        match self {
            Self::Pay { amount, .. } => *amount,
            Self::Hold { amount, .. } => *amount,
        }
    }

    /// Returns the receiver account ID if this is a `Pay` leg.
    pub fn receiver(&self) -> Option<&AccountId> {
        match self {
            Self::Pay { receiver, .. } => Some(receiver),
            Self::Hold { .. } => None,
        }
    }

    /// Returns the assigned settlement asset if allocated.
    pub fn asset(&self) -> Option<&TokenId> {
        match self {
            Self::Pay { asset, .. } => asset.as_ref(),
            Self::Hold { asset, .. } => asset.as_ref(),
        }
    }

    /// Sets the assigned settlement asset.
    pub fn set_asset(&mut self, token_id: TokenId) {
        match self {
            Self::Pay { asset, .. } => *asset = Some(token_id),
            Self::Hold { asset, .. } => *asset = Some(token_id),
        }
    }
}

/// Payment log quote entry (Blueprint 2.1).
///
/// Written by an authorized `quote_writer` before a deposit address is shown.
/// Duplicate `quote_id` panics. The log never decides amounts.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    /// Unique quote identifier.
    pub quote_id: String,
    /// 1Click or bridge deposit address displayed to payer.
    pub deposit_address: String,
    /// Requested deadline in unix seconds.
    pub deadline_requested: u64,
    /// Payer refund address on origin chain.
    pub refund_to: String,
    /// Route identifier from routes configuration.
    pub route_id: String,
}

/// Debtor co-signature for invoice cancellation (Blueprint 2.2 line 65).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DebtorCosig {
    /// EVM EIP-712 signature over OPENRAIL_CANCEL_V1.
    Evm { chain_id: u64, sig: HexBytes },
    /// NEAR direct call from the debtor account.
    Near,
}

/// Global contract configuration (Blueprint 2.1).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// The 4 USDC Intents settlement asset token IDs (TokenId).
    pub settlement_assets: Vec<TokenId>,
    /// Code hash of the vault v2 published global contract.
    pub vault_code_hash: Hex32,
    /// Protocol fee account receiving 25 bps.
    pub fee_account: AccountId,
    /// Authorized watcher accounts for automated pump calls.
    pub watchers: Vec<AccountId>,
    /// Authorized quote writers permitted to call `log_quote`.
    pub quote_writers: Vec<AccountId>,
    /// Authorized issuers permitted to invoke `issue_for`.
    pub issuers: Vec<AccountId>,
    /// Emergency circuit-breaker: pause new claim issuance.
    pub issue_paused: bool,
}

/// The core `Claim` record stored under prefix `c:`, keyed by `token_id` (Blueprint 2.1).
///
/// Note: `undistributed` is stored separately under prefix `u:` per Finding 6 and Blueprint 2.1.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    /// Token ID formatted `c-<n>`. Written by `issue`; immutable.
    pub token_id: String,

    /// Kind of claim (0 = Invoice; modules add others). Written by `issue`; immutable.
    pub kind: u8,

    /// Initial issuer account ID. Written by `issue`; immutable.
    pub issuer_id: AccountId,

    /// Current owner account ID. Written by `issue`, updated only via NEP-171 under transfer rules (2.4).
    pub owner_id: AccountId,

    /// Dedicated sub-account `c-<n>.<root>` holding vault and balances. Written by `issue`; immutable.
    pub claim_account: AccountId,

    /// Counterparty debtor. Written by `issue`; immutable; None only if kind_rules allows.
    pub debtor: Option<Debtor>,

    /// SHA-256 hash of canonical terms JSON (2.6). Written by `issue`; immutable.
    pub terms_hash: Hex32,

    /// Total amount due in USDC base units (6 decimals). Written by `issue`; immutable.
    pub amount_due: U128,

    /// Due date in unix seconds. Written by `issue`; immutable.
    pub due_date: u64,

    /// Debtor acknowledgment. Written exclusively once by `acknowledge_*`; write-once.
    pub ack: Option<Ack>,

    /// Current lifecycle status. Transition rules enforced (2.3).
    pub status: Status,

    /// Concurrency lock. Managed by contract callbacks and transfer preparation (2.3).
    pub lock: Lock,

    /// Accepted settlement assets (USDC token IDs). Copied from config at `issue`; immutable.
    pub settlement_assets: Vec<TokenId>,

    /// Cumulative USDC base units booked to this claim. Reconcile callback; only increases.
    pub booked_total: U128,

    /// Value allocated to payees at booking. Reconcile callback; only increases.
    pub distributed_total: U128,

    /// Cumulative 25 bps protocol fees calculated on booking. Reconcile callback; only increases.
    pub fee_total: U128,

    /// Value beyond `amount_due` or booked post-closure. Reconcile increases, `release_surplus` decreases.
    pub surplus: U128,

    /// Value-less discharge credit applied by module hooks. Reconcile/apply_credit; only increases; <= outstanding.
    pub credit_total: U128,

    /// Source identifier of first applied credit. Set once on first credit; write-once.
    pub credit_source: Option<u8>,

    /// Last observed balance per settlement asset on `claim_account`. Updated in reconcile callbacks (2.5).
    pub last_seen_balance: HashMap<TokenId, U128>,

    /// SHA-256 hash of legal assignment document. Required on sale when receiver != issuer (2.4 rule 4).
    pub assignment_doc_hash: Option<Hex32>,

    /// Block height at which claim was issued. Written by `issue`; immutable.
    pub created_block: u64,
}

impl Claim {
    /// Updates claim status according to the Paid rule (Blueprint 2.3).
    pub fn update_status_paid_rule(&mut self) {
        if self.status.is_terminal() {
            return;
        }
        let booked_net = self.booked_total.0.saturating_sub(self.surplus.0);
        let total_discharged = booked_net.saturating_add(self.credit_total.0);
        if total_discharged >= self.amount_due.0 {
            self.status = Status::Paid;
        } else if total_discharged > 0 {
            self.status = Status::PartiallyPaid;
        }
    }
}

pub use crate::hooks::KindRules;

/// JSON view representation of a claim including its undistributed legs.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimView {
    pub token_id: String,
    pub kind: u8,
    pub issuer_id: AccountId,
    pub owner_id: AccountId,
    pub claim_account: AccountId,
    pub debtor: Option<Debtor>,
    pub terms_hash: Hex32,
    pub amount_due: U128,
    pub due_date: u64,
    pub ack: Option<Ack>,
    pub status: Status,
    pub lock: Lock,
    pub settlement_assets: Vec<TokenId>,
    pub booked_total: U128,
    pub distributed_total: U128,
    pub fee_total: U128,
    pub surplus: U128,
    pub credit_total: U128,
    pub credit_source: Option<u8>,
    pub last_seen_balance: HashMap<TokenId, U128>,
    pub undistributed: Vec<Leg>,
    pub kind_rules: KindRules,
    pub assignment_doc_hash: Option<Hex32>,
    pub created_block: u64,
}

impl ClaimView {
    pub fn from_claim(claim: Claim, undistributed: Vec<Leg>) -> Self {
        let kind_rules = crate::hooks::dispatch_kind_rules(claim.kind);
        Self {
            token_id: claim.token_id,
            kind: claim.kind,
            issuer_id: claim.issuer_id,
            owner_id: claim.owner_id,
            claim_account: claim.claim_account,
            debtor: claim.debtor,
            terms_hash: claim.terms_hash,
            amount_due: claim.amount_due,
            due_date: claim.due_date,
            ack: claim.ack,
            status: claim.status,
            lock: claim.lock,
            settlement_assets: claim.settlement_assets,
            booked_total: claim.booked_total,
            distributed_total: claim.distributed_total,
            fee_total: claim.fee_total,
            surplus: claim.surplus,
            credit_total: claim.credit_total,
            credit_source: claim.credit_source,
            last_seen_balance: claim.last_seen_balance,
            undistributed,
            kind_rules,
            assignment_doc_hash: claim.assignment_doc_hash,
            created_block: claim.created_block,
        }
    }
}

// ──────────────────────────────────────────────
// NEP-171 / NEP-177 / NEP-178 Standard Types
// ──────────────────────────────────────────────

/// NEP-177 Contract Metadata.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NFTContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

/// NEP-177 Individual Token Metadata.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub copies: Option<u64>,
    pub issued_at: Option<u64>,
    pub expires_at: Option<u64>,
    pub starts_at: Option<u64>,
    pub updated_at: Option<u64>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

/// NEP-171 / NEP-177 JSON Token representation.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonToken {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: Option<TokenMetadata>,
    pub approved_account_ids: Option<HashMap<AccountId, u64>>,
}

// ──────────────────────────────────────────────
// Sponsor Pool Types (Blueprint REL-1, Card A10)
// ──────────────────────────────────────────────

/// View structure returned by `sponsor_status(account_id)` (Blueprint REL-1, Card A10).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SponsorStatusView {
    pub pool: U128,
    pub cap: u64,
    pub used: u64,
}
