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
// Hook Composition & Dispatcher Mechanisms (Blueprint 1.4)
// ──────────────────────────────────────────────

/// Composed check_transfer: core first, then modules in order; first refusal wins.
/// A module may refuse, but can never permit what core refuses.
pub fn dispatch_check_transfer_with(
    hooks: &[&dyn Hook],
    claim: &Claim,
    receiver: &AccountId,
) -> Result<(), Refusal> {
    CoreDefaultHook.check_transfer(claim, receiver)?;
    for hook in hooks {
        hook.check_transfer(claim, receiver)?;
    }
    Ok(())
}

/// Composed check_cancel: core first, then modules in order; first refusal wins.
pub fn dispatch_check_cancel_with(hooks: &[&dyn Hook], claim: &Claim) -> Result<(), Refusal> {
    CoreDefaultHook.check_cancel(claim)?;
    for hook in hooks {
        hook.check_cancel(claim)?;
    }
    Ok(())
}

/// Composed check_writeoff: core first, then modules in order; first refusal wins.
pub fn dispatch_check_writeoff_with(hooks: &[&dyn Hook], claim: &Claim) -> Result<(), Refusal> {
    CoreDefaultHook.check_writeoff(claim)?;
    for hook in hooks {
        hook.check_writeoff(claim)?;
    }
    Ok(())
}

/// Composed check_credit: core enforces single-source rule, then modules in order.
pub fn dispatch_check_credit_with(
    hooks: &[&dyn Hook],
    claim: &Claim,
    source: u8,
) -> Result<(), Refusal> {
    if let Some(existing) = claim.credit_source {
        if existing != source {
            return Err(Refusal::new("only one credit source permitted per claim"));
        }
    }
    CoreDefaultHook.check_credit(claim, source)?;
    for hook in hooks {
        hook.check_credit(claim, source)?;
    }
    Ok(())
}

/// Composed adjust_booking: core default first; each module may only lower payment / add credit
/// within credit <= outstanding.
pub fn dispatch_adjust_booking_with(
    hooks: &[&dyn Hook],
    claim: &Claim,
    input: BookingInput,
) -> BookingAdjust {
    let mut current = CoreDefaultHook.adjust_booking(claim, input.clone());
    for hook in hooks {
        let mod_adj = hook.adjust_booking(claim, input.clone());
        if mod_adj.payment.0 <= current.payment.0 {
            current.payment = mod_adj.payment;
        }
        let max_credit = std::cmp::min(input.outstanding.0, mod_adj.credit.0);
        if max_credit >= current.credit.0 {
            current.credit = U128(max_credit);
        }
    }
    current
}

/// Composed split_distribution: legs must sum to net, else fall back to core default and emit anomaly.
pub fn dispatch_split_distribution_with(hooks: &[&dyn Hook], claim: &Claim, net: U128) -> Vec<Leg> {
    let core_default = CoreDefaultHook.split_distribution(claim, net);
    if hooks.is_empty() {
        return core_default;
    }
    for hook in hooks {
        let legs = hook.split_distribution(claim, net);
        let sum: u128 = legs.iter().map(|l| l.amount().0).sum();
        if sum == net.0 {
            return legs;
        } else {
            // Legs violate conservation law! Fall back to core default and log anomaly.
            near_sdk::env::log_str("ANOMALY: module distribution legs do not sum to net");
        }
    }
    core_default
}

/// Composed in_motion: returns true if core or any module is in motion.
pub fn dispatch_in_motion_with(hooks: &[&dyn Hook], claim: &Claim) -> bool {
    if CoreDefaultHook.in_motion(claim) {
        return true;
    }
    for hook in hooks {
        if hook.in_motion(claim) {
            return true;
        }
    }
    false
}

/// Composed on_booked: invokes all hooks.
pub fn dispatch_on_booked_with(hooks: &[&dyn Hook], claim: &Claim, booking: &Booking) {
    CoreDefaultHook.on_booked(claim, booking);
    for hook in hooks {
        hook.on_booked(claim, booking);
    }
}

/// Composed kind_rules: kind 0 is invoice; otherwise queries modules.
pub fn dispatch_kind_rules_with(hooks: &[&dyn Hook], kind: u8) -> KindRules {
    if kind == 0 {
        return KindRules::invoice();
    }
    if let Some(hook) = hooks.first() {
        return hook.kind_rules(kind);
    }
    KindRules::default()
}

// ──────────────────────────────────────────────
// Default Dispatchers (Query crate::modules::registered())
// ──────────────────────────────────────────────

pub fn dispatch_check_transfer(claim: &Claim, receiver: &AccountId) -> Result<(), Refusal> {
    let hooks = crate::modules::registered();
    dispatch_check_transfer_with(&hooks, claim, receiver)
}

pub fn dispatch_check_cancel(claim: &Claim) -> Result<(), Refusal> {
    let hooks = crate::modules::registered();
    dispatch_check_cancel_with(&hooks, claim)
}

pub fn dispatch_check_writeoff(claim: &Claim) -> Result<(), Refusal> {
    let hooks = crate::modules::registered();
    dispatch_check_writeoff_with(&hooks, claim)
}

pub fn dispatch_check_credit(claim: &Claim, source: u8) -> Result<(), Refusal> {
    let hooks = crate::modules::registered();
    dispatch_check_credit_with(&hooks, claim, source)
}

pub fn dispatch_adjust_booking(claim: &Claim, input: BookingInput) -> BookingAdjust {
    let hooks = crate::modules::registered();
    dispatch_adjust_booking_with(&hooks, claim, input)
}

pub fn dispatch_split_distribution(claim: &Claim, net: U128) -> Vec<Leg> {
    let hooks = crate::modules::registered();
    dispatch_split_distribution_with(&hooks, claim, net)
}

pub fn dispatch_in_motion(claim: &Claim) -> bool {
    let hooks = crate::modules::registered();
    dispatch_in_motion_with(&hooks, claim)
}

pub fn dispatch_on_booked(claim: &Claim, booking: &Booking) {
    let hooks = crate::modules::registered();
    dispatch_on_booked_with(&hooks, claim, booking);
}

pub fn dispatch_kind_rules(kind: u8) -> KindRules {
    let hooks = crate::modules::registered();
    dispatch_kind_rules_with(&hooks, kind)
}
