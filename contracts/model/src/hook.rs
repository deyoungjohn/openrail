//! Module hook trait and core default implementation (Blueprint 2.5, 2.11).

use crate::types::{BookingInfo, Claim, KindRules, Leg};

/// Optional module extension hook trait.
pub trait Hook: Send + Sync {
    /// Validates whether a claim transfer to `new_owner` is permitted.
    fn check_transfer(&self, _claim: &Claim, _new_owner: &str) -> Result<(), String> {
        Ok(())
    }

    /// Validates whether a claim cancellation is permitted.
    fn check_cancel(&self, _claim: &Claim) -> Result<(), String> {
        Ok(())
    }

    /// Validates whether a writeoff closure is permitted.
    fn check_writeoff(&self, _claim: &Claim) -> Result<(), String> {
        Ok(())
    }

    /// Adjusts booking amounts returning `(payment, credit)`.
    ///
    /// Core default: `(min(delta, outstanding), 0)`.
    fn adjust_booking(
        &self,
        _claim: &Claim,
        delta: u128,
        outstanding: u128,
        _now: u64,
    ) -> (u128, u128) {
        (std::cmp::min(delta, outstanding), 0)
    }

    /// Splits net payment into distribution legs.
    ///
    /// Core default: single `Leg::Pay` forwarding net to current `claim.owner_id`.
    fn split_distribution(&self, claim: &Claim, net: u128) -> Vec<Leg> {
        if net == 0 {
            Vec::new()
        } else {
            vec![Leg::pay(claim.owner_id.clone(), net)]
        }
    }

    /// Callback invoked immediately after booking state updates.
    fn on_booked(&self, _claim: &mut Claim, _booking: &BookingInfo) {}

    /// Look up kind rules for the specified claim kind.
    fn kind_rules(&self, kind: u8) -> Option<KindRules> {
        if kind == 0 {
            Some(KindRules::invoice())
        } else {
            None
        }
    }
}

/// Core default hook implementation when no custom module hooks are installed.
#[derive(Clone, Copy, Debug, Default)]
pub struct CoreDefaultHook;

impl Hook for CoreDefaultHook {}
