//! Core types for the Openrail protocol (Blueprint 2.1).
//!
//! All types derive Borsh and JSON serialization using `near_sdk`.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};
use std::collections::HashMap;

/// The Debtor on a claim (Blueprint 2.1).
///
/// Written by `issue`, immutable thereafter.
/// Can only be `None` if `kind_rules(kind).debtor_optional` permits.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Debtor {
    /// 20-byte EVM address of the debtor.
    Evm([u8; 20]),
    /// NEAR account identifier of the debtor.
    Near(AccountId),
}

/// Acknowledgment scheme used by the debtor (Blueprint 2.1, 2.7).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AckScheme {
    /// EIP-712 signed typed data on an accepted EVM chain.
    Evm { chain_id: u64, signer: [u8; 20] },
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
        asset: Option<AccountId>,
    },
    /// Retained in the claim account for delayed payout by an enabled module.
    Hold {
        module_id: String,
        amount: U128,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        asset: Option<AccountId>,
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
    pub fn pay_with_asset(receiver: AccountId, amount: U128, asset: AccountId) -> Self {
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
    pub fn asset(&self) -> Option<&AccountId> {
        match self {
            Self::Pay { asset, .. } => asset.as_ref(),
            Self::Hold { asset, .. } => asset.as_ref(),
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
    Evm { chain_id: u64, sig: Vec<u8> },
    /// NEAR direct call from the debtor account.
    Near,
}

/// Global contract configuration (Blueprint 2.1).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// The 4 USDC Intents settlement asset token IDs.
    pub settlement_assets: Vec<AccountId>,
    /// Code hash of the vault v2 published global contract.
    pub vault_code_hash: [u8; 32],
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
    pub terms_hash: [u8; 32],

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
    pub settlement_assets: Vec<AccountId>,

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
    pub last_seen_balance: HashMap<AccountId, U128>,

    /// Undistributed payment legs pending retry (prefix `u:`). Receiver fixed at booking (D-S8).
    pub undistributed: Vec<Leg>,

    /// SHA-256 hash of legal assignment document. Required on sale when receiver != issuer (2.4 rule 4).
    pub assignment_doc_hash: Option<[u8; 32]>,

    /// Block height at which claim was issued. Written by `issue`; immutable.
    pub created_block: u64,
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
