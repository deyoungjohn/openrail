//! Hook interface and dispatcher (Blueprint 1.4).
//!
//! Frozen in Phase 0 (P0.3). Core calls `hooks::*` at fixed points.
//! With no modules enabled, every hook returns the core default (identity).

use crate::types::{Claim, Leg};
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};
use std::fmt;

/// Input to booking adjustment hook (Blueprint 1.4, 2.5).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookingInput {
    /// Newly observed balance increase across settlement assets.
    pub delta: U128,
    /// Outstanding balance on the claim before this booking.
    pub outstanding: U128,
    /// Current block timestamp (unix seconds).
    pub now: u64,
}

/// Output from booking adjustment hook (Blueprint 1.4).
///
/// A module may lower `payment` and return a value-less `credit`.
/// Core enforces: at most one `credit_source` per claim; `credit <= outstanding`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookingAdjust {
    /// Portion of delta allocated toward paying down the claim.
    pub payment: U128,
    /// Value-less discharge credit granted by the module.
    pub credit: U128,
}

/// Rejection reason returned by hook validation checks.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub reason: String,
    pub rule: Option<u32>,
}

impl Refusal {
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            rule: None,
        }
    }

    pub fn with_rule(rule: u32, reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            rule: Some(rule),
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(r) = self.rule {
            write!(f, "Rule {}: {}", r, self.reason)
        } else {
            write!(f, "{}", self.reason)
        }
    }
}

impl std::error::Error for Refusal {}

/// Rules governing a claim kind (Blueprint 1.4, 2.4, 2.8).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KindRules {
    /// Debtor acknowledgment required before claim can be sold/transferred (Greensill rule).
    pub ack_required_for_sale: bool,
    /// Whether claims of this kind can be sold.
    pub sellable: bool,
    /// Quote validity window in seconds (default 3600 = 60 min).
    pub quote_deadline: u64,
    /// Whether debtor field may be None on issuance.
    pub debtor_optional: bool,
}

impl Default for KindRules {
    fn default() -> Self {
        Self {
            ack_required_for_sale: true,
            sellable: true,
            quote_deadline: 3600,
            debtor_optional: false,
        }
    }
}

impl KindRules {
    /// Standard invoice rules (Blueprint 1.4).
    pub fn invoice() -> Self {
        Self::default()
    }
}

/// Details of a finalized booking event passed to `on_booked` (Blueprint 1.4, 2.5).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Booking {
    pub payment: U128,
    pub surplus: U128,
    pub fee: U128,
    pub credit: U128,
    pub legs: Vec<Leg>,
}

/// The Nine Hooks trait (Blueprint 1.4).
///
/// Every hook provides a default implementation representing pure core behavior.
pub trait Hook {
    /// Check whether a transfer is permitted.
    ///
    /// Core default: Ok. A module may refuse, never permit something core refuses.
    fn check_transfer(&self, _claim: &Claim, _receiver: &AccountId) -> Result<(), Refusal> {
        Ok(())
    }

    /// Check whether a cancellation is permitted.
    fn check_cancel(&self, _claim: &Claim) -> Result<(), Refusal> {
        Ok(())
    }

    /// Check whether writing off a shortfall is permitted.
    fn check_writeoff(&self, _claim: &Claim) -> Result<(), Refusal> {
        Ok(())
    }

    /// Adjust payment vs credit split on booking.
    ///
    /// Core default: { payment: min(delta, outstanding), credit: 0 }.
    fn adjust_booking(&self, _claim: &Claim, input: BookingInput) -> BookingAdjust {
        let payment = std::cmp::min(input.delta.0, input.outstanding.0);
        BookingAdjust {
            payment: payment.into(),
            credit: 0.into(),
        }
    }

    /// Split net payment (after 25 bps fee) into legs.
    ///
    /// Core default: [Leg::Pay(owner_id, net)].
    fn split_distribution(&self, claim: &Claim, net: U128) -> Vec<Leg> {
        vec![Leg::pay(claim.owner_id.clone(), net)]
    }

    /// Check whether a credit source may apply credit to this claim.
    fn check_credit(&self, _claim: &Claim, _source: u8) -> Result<(), Refusal> {
        Ok(())
    }

    /// Whether money is moving towards the claim account (blocks transfer like a lock).
    fn in_motion(&self, _claim: &Claim) -> bool {
        false
    }

    /// Module bookkeeping callback after booking and distribution initiation.
    fn on_booked(&self, _claim: &Claim, _booking: &Booking) {}

    /// Query rules for a given claim kind.
    fn kind_rules(&self, kind: u8) -> KindRules {
        if kind == 0 {
            KindRules::invoice()
        } else {
            KindRules::default()
        }
    }
}

/// Core default hook implementation implementing identity behavior.
pub struct CoreDefaultHook;
impl Hook for CoreDefaultHook {}

// ──────────────────────────────────────────────
// Hook Dispatcher (Iterates crate::modules::ENABLED)
// ──────────────────────────────────────────────

/// Dispatches `check_transfer` across enabled modules.
pub fn dispatch_check_transfer(claim: &Claim, receiver: &AccountId) -> Result<(), Refusal> {
    if crate::modules::ENABLED.is_empty() {
        return CoreDefaultHook.check_transfer(claim, receiver);
    }
    // Modules will register here when compiled in.
    CoreDefaultHook.check_transfer(claim, receiver)
}

/// Dispatches `check_cancel` across enabled modules.
pub fn dispatch_check_cancel(claim: &Claim) -> Result<(), Refusal> {
    if crate::modules::ENABLED.is_empty() {
        return CoreDefaultHook.check_cancel(claim);
    }
    CoreDefaultHook.check_cancel(claim)
}

/// Dispatches `check_writeoff` across enabled modules.
pub fn dispatch_check_writeoff(claim: &Claim) -> Result<(), Refusal> {
    if crate::modules::ENABLED.is_empty() {
        return CoreDefaultHook.check_writeoff(claim);
    }
    CoreDefaultHook.check_writeoff(claim)
}

/// Dispatches `adjust_booking` across enabled modules.
pub fn dispatch_adjust_booking(claim: &Claim, input: BookingInput) -> BookingAdjust {
    if crate::modules::ENABLED.is_empty() {
        return CoreDefaultHook.adjust_booking(claim, input);
    }
    CoreDefaultHook.adjust_booking(claim, input)
}

/// Dispatches `split_distribution` across enabled modules.
pub fn dispatch_split_distribution(claim: &Claim, net: U128) -> Vec<Leg> {
    if crate::modules::ENABLED.is_empty() {
        return CoreDefaultHook.split_distribution(claim, net);
    }
    CoreDefaultHook.split_distribution(claim, net)
}

/// Dispatches `check_credit` across enabled modules.
pub fn dispatch_check_credit(claim: &Claim, source: u8) -> Result<(), Refusal> {
    if crate::modules::ENABLED.is_empty() {
        return CoreDefaultHook.check_credit(claim, source);
    }
    CoreDefaultHook.check_credit(claim, source)
}

/// Dispatches `in_motion` across enabled modules.
pub fn dispatch_in_motion(claim: &Claim) -> bool {
    if crate::modules::ENABLED.is_empty() {
        return CoreDefaultHook.in_motion(claim);
    }
    CoreDefaultHook.in_motion(claim)
}

/// Dispatches `on_booked` across enabled modules.
pub fn dispatch_on_booked(claim: &Claim, booking: &Booking) {
    if crate::modules::ENABLED.is_empty() {
        CoreDefaultHook.on_booked(claim, booking);
        return;
    }
    CoreDefaultHook.on_booked(claim, booking);
}

/// Dispatches `kind_rules` for a given kind across enabled modules.
pub fn dispatch_kind_rules(kind: u8) -> KindRules {
    if crate::modules::ENABLED.is_empty() {
        return CoreDefaultHook.kind_rules(kind);
    }
    CoreDefaultHook.kind_rules(kind)
}
