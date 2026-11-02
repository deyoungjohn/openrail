//! Actions, events, and errors for the Openrail state machine model.

use crate::types::{AccountId, AckScheme, Debtor, DebtorCosig, Hex20, Hex32, Leg, Quote, TokenId};
use serde::{Deserialize, Serialize};

/// State machine actions representing transactions or external events.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Action {
    /// Issue a new claim directly (Blueprint 2.2).
    Issue {
        token_id: String,
        kind: u8,
        issuer_id: AccountId,
        debtor: Option<Debtor>,
        terms_hash: Hex32,
        amount_due: u128,
        due_date: u64,
    },
    /// Issue a new claim on behalf of a business using storage credit (Blueprint 2.2).
    IssueFor {
        caller: AccountId,
        business: AccountId,
        token_id: String,
        kind: u8,
        debtor: Option<Debtor>,
        terms_hash: Hex32,
        amount_due: u128,
        due_date: u64,
    },
    /// Deposit storage credit for a business (Blueprint 2.2).
    DepositStorageCredit { business: AccountId, amount: u128 },
    /// Withdraw storage credit (Blueprint 2.2).
    WithdrawStorageCredit { business: AccountId, amount: u128 },
    /// Debtor acknowledgment via NEAR direct call (Blueprint 2.2).
    AcknowledgeNear { token_id: String, caller: AccountId },
    /// Debtor acknowledgment via EVM EIP-712 signature (Blueprint 2.2, 2.7).
    AcknowledgeEvm {
        token_id: String,
        chain_id: u64,
        signer: Hex20,
    },
    /// External payment arriving at claim sub-account in Intents (Blueprint 2.5).
    DepositIntentsBalance {
        token_id: String,
        asset: TokenId,
        amount: u128,
    },
    /// Authorized quote writer logs quote before payment (Blueprint 2.1, 2.2).
    LogQuote {
        caller: AccountId,
        token_id: String,
        quote: Quote,
    },
    /// Open transfer window if checks pass (Blueprint 2.2, 2.3).
    PrepareTransfer { caller: AccountId, token_id: String },
    /// Transfer claim ownership under rules 1–8 (Blueprint 2.2, 2.4).
    Transfer {
        caller: AccountId,
        token_id: String,
        new_owner: AccountId,
        memo_assignment_doc_hash: Option<Hex32>,
        attached_yocto: u128,
    },
    /// Reconcile claim balances and book payment (Blueprint 2.2, 2.5).
    Reconcile {
        token_id: String,
        /// Optional outcome flags for each distribution leg: `true` = failed, `false` = succeeded.
        leg_failures: Vec<bool>,
    },
    /// Retry all undistributed legs (Blueprint 2.2, 2.5).
    RetryDistribution {
        token_id: String,
        /// Outcome flags for each undistributed leg: `true` = failed, `false` = succeeded.
        leg_failures: Vec<bool>,
    },
    /// Clear stale lock (Blueprint 2.2, 2.3).
    ClearStaleLock { token_id: String },
    /// Cancel unpaid claim (Blueprint 2.2, 2.3).
    Cancel {
        caller: AccountId,
        token_id: String,
        debtor_cosig: Option<DebtorCosig>,
    },
    /// Close fully paid claim (Blueprint 2.2, 2.3).
    Close { caller: AccountId, token_id: String },
    /// Close claim with writeoff shortfall (Blueprint 2.2, 2.3).
    CloseWriteoff { caller: AccountId, token_id: String },
    /// Release surplus funds to owner (Blueprint 2.2, 2.3).
    ReleaseSurplus { caller: AccountId, token_id: String },
    /// Apply value-less discharge credit (Blueprint 2.1, 2.3).
    ApplyCredit {
        token_id: String,
        amount: u128,
        source: u8,
    },
}

/// Events emitted during state transitions (Blueprint 2.9).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Event {
    Issue {
        token_id: String,
        owner_id: AccountId,
        claim_account: AccountId,
        amount_due: u128,
    },
    Ack {
        token_id: String,
        scheme: AckScheme,
    },
    QuoteLogged {
        token_id: String,
        quote_id: String,
    },
    Booked {
        token_id: String,
        payment: u128,
        surplus_part: u128,
        fee: u128,
        credit: u128,
        legs: Vec<Leg>,
    },
    Distributed {
        token_id: String,
        leg: Leg,
    },
    DistributionFailed {
        token_id: String,
        leg: Leg,
    },
    SurplusReleased {
        token_id: String,
        amount: u128,
        receiver: AccountId,
    },
    TransferWindow {
        token_id: String,
        until: u64,
    },
    Transferred {
        token_id: String,
        old_owner: AccountId,
        new_owner: AccountId,
    },
    Cancel {
        token_id: String,
    },
    Close {
        token_id: String,
    },
    Writeoff {
        token_id: String,
        shortfall: u128,
    },
    LockCleared {
        token_id: String,
    },
    CreditApplied {
        token_id: String,
        amount: u128,
        source: u8,
    },
}

/// Errors raised when an action violates state machine invariants or rules.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelError {
    ClaimNotFound(String),
    ClaimAlreadyExists(String),
    IssuePaused,
    Unauthorized(String),
    NoStorageCredit,
    InvalidAmount(String),
    DebtorRequired,
    AlreadyAcknowledged,
    InvalidSigner,
    DuplicateQuote(String),
    ClaimLocked(String),
    LockNotStale,
    NoLock,
    /// Transfer rule violation with rule number 1–8.
    TransferRuleViolation(u8, String),
    StatusViolation(String),
    CancelDebtorCosigRequired,
    CancelDisallowed,
    CloseDisallowed(String),
    WriteoffDisallowed(String),
    NoSurplus,
    CreditExceedsOutstanding,
    CreditSourceMismatch,
    UnknownKind(u8),
    HookRefusal(String),
}

impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ClaimNotFound(id) => write!(f, "claim not found: {}", id),
            Self::ClaimAlreadyExists(id) => write!(f, "claim already exists: {}", id),
            Self::IssuePaused => write!(f, "issuance is paused"),
            Self::Unauthorized(msg) => write!(f, "unauthorized: {}", msg),
            Self::NoStorageCredit => write!(f, "insufficient storage credit"),
            Self::InvalidAmount(msg) => write!(f, "invalid amount: {}", msg),
            Self::DebtorRequired => write!(f, "debtor is required for this kind"),
            Self::AlreadyAcknowledged => write!(f, "claim is already acknowledged"),
            Self::InvalidSigner => write!(f, "signer does not match debtor"),
            Self::DuplicateQuote(id) => write!(f, "duplicate quote id: {}", id),
            Self::ClaimLocked(msg) => write!(f, "claim is locked: {}", msg),
            Self::LockNotStale => write!(f, "lock is not stale"),
            Self::NoLock => write!(f, "claim has no lock"),
            Self::TransferRuleViolation(rule, msg) => {
                write!(f, "transfer rule {} violation: {}", rule, msg)
            }
            Self::StatusViolation(msg) => write!(f, "status violation: {}", msg),
            Self::CancelDebtorCosigRequired => {
                write!(
                    f,
                    "debtor co-signature required to cancel acknowledged claim"
                )
            }
            Self::CancelDisallowed => write!(f, "cannot cancel claim with booked value or lock"),
            Self::CloseDisallowed(msg) => write!(f, "cannot close claim: {}", msg),
            Self::WriteoffDisallowed(msg) => write!(f, "cannot write off claim: {}", msg),
            Self::NoSurplus => write!(f, "no surplus to release"),
            Self::CreditExceedsOutstanding => write!(f, "credit exceeds outstanding amount"),
            Self::CreditSourceMismatch => write!(f, "credit source mismatch"),
            Self::UnknownKind(k) => write!(f, "unknown claim kind: {}", k),
            Self::HookRefusal(msg) => write!(f, "hook refused action: {}", msg),
        }
    }
}

impl std::error::Error for ModelError {}
