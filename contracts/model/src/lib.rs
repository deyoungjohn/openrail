//! Pure-Rust reference model for the Openrail protocol (Blueprint 2.1–2.5, 2.11, 3.2).
//!
//! Rebuilt strictly from the specification without NEAR types, SDK dependencies,
//! or references to internal contract implementations.

pub mod actions;
pub mod hook;
pub mod invariants;
pub mod model;
pub mod strategy;
pub mod types;

pub use actions::{Action, Event, ModelError};
pub use hook::{CoreDefaultHook, Hook};
pub use invariants::{
    check_conservation_v3, check_conservation_v3_with_released, check_counters_monotonic,
    check_failed_distribution_keeps_booking, check_fee_bounded, check_reconcile_idempotent,
    check_status_matches_amounts_v3, check_status_matches_amounts_v3_with_released,
    check_undistributed_payee_fixed_at_booking, InvariantViolation,
};
pub use model::{Model, Mutations};
pub use types::{
    AccountId, Ack, AckScheme, Claim, Config, Debtor, DebtorCosig, Hex20, Hex32, KindRules, Leg,
    Lock, Quote, Status, TokenId,
};
