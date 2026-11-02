//! Named invariant checkers from Blueprint 2.11.

use crate::types::{Claim, Leg, Status};

/// Invariant violation error detailing which invariant failed and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvariantViolation {
    pub invariant_name: &'static str,
    pub message: String,
}

impl std::fmt::Display for InvariantViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "INVARIANT [{}] VIOLATED: {}",
            self.invariant_name, self.message
        )
    }
}

impl std::error::Error for InvariantViolation {}

/// 1. `conservation_v3`: `booked_total == distributed_total + fee_total + surplus + held_total (+ released_surplus)` (Blueprint 2.11).
pub fn check_conservation_v3(claim: &Claim) -> Result<(), InvariantViolation> {
    check_conservation_v3_with_released(claim, 0)
}

/// Conservation check accounting for surplus released to owner.
pub fn check_conservation_v3_with_released(
    claim: &Claim,
    released_surplus: u128,
) -> Result<(), InvariantViolation> {
    let held_total: u128 = claim
        .undistributed
        .iter()
        .filter_map(|leg| match leg {
            Leg::Hold { amount, .. } => Some(*amount),
            _ => None,
        })
        .sum();

    let sum = claim
        .distributed_total
        .checked_add(claim.fee_total)
        .and_then(|s| s.checked_add(claim.surplus))
        .and_then(|s| s.checked_add(held_total))
        .and_then(|s| s.checked_add(released_surplus))
        .ok_or_else(|| InvariantViolation {
            invariant_name: "conservation_v3",
            message: "overflow calculating sum of distributed, fee, surplus, held, released".into(),
        })?;

    if claim.booked_total != sum {
        return Err(InvariantViolation {
            invariant_name: "conservation_v3",
            message: format!(
                "booked_total ({}) != distributed ({}) + fee ({}) + surplus ({}) + held ({}) + released ({}) = sum ({})",
                claim.booked_total,
                claim.distributed_total,
                claim.fee_total,
                claim.surplus,
                held_total,
                released_surplus,
                sum
            ),
        });
    }

    Ok(())
}

/// 2. `counters_monotonic`: `booked_total`, `distributed_total`, `fee_total`, `credit_total` never decrease (Blueprint 2.11).
pub fn check_counters_monotonic(prev: &Claim, curr: &Claim) -> Result<(), InvariantViolation> {
    if curr.booked_total < prev.booked_total {
        return Err(InvariantViolation {
            invariant_name: "counters_monotonic",
            message: format!(
                "booked_total decreased: {} -> {}",
                prev.booked_total, curr.booked_total
            ),
        });
    }
    if curr.distributed_total < prev.distributed_total {
        return Err(InvariantViolation {
            invariant_name: "counters_monotonic",
            message: format!(
                "distributed_total decreased: {} -> {}",
                prev.distributed_total, curr.distributed_total
            ),
        });
    }
    if curr.fee_total < prev.fee_total {
        return Err(InvariantViolation {
            invariant_name: "counters_monotonic",
            message: format!(
                "fee_total decreased: {} -> {}",
                prev.fee_total, curr.fee_total
            ),
        });
    }
    if curr.credit_total < prev.credit_total {
        return Err(InvariantViolation {
            invariant_name: "counters_monotonic",
            message: format!(
                "credit_total decreased: {} -> {}",
                prev.credit_total, curr.credit_total
            ),
        });
    }

    Ok(())
}

/// 3. `status_matches_amounts_v3`: status strictly reflects the paid rule and amounts (Blueprint 2.3, 2.11).
pub fn check_status_matches_amounts_v3(claim: &Claim) -> Result<(), InvariantViolation> {
    check_status_matches_amounts_v3_with_released(claim, 0)
}

/// Status matches amounts check accounting for released surplus.
pub fn check_status_matches_amounts_v3_with_released(
    claim: &Claim,
    released_surplus: u128,
) -> Result<(), InvariantViolation> {
    let total_surplus = claim.surplus.saturating_add(released_surplus);
    let eff = claim
        .booked_total
        .saturating_sub(total_surplus)
        .saturating_add(claim.credit_total);

    match claim.status {
        Status::Issued => {
            if eff != 0 {
                return Err(InvariantViolation {
                    invariant_name: "status_matches_amounts_v3",
                    message: format!("Issued claim has non-zero effective payment: {}", eff),
                });
            }
        }
        Status::PartiallyPaid => {
            if eff == 0 || eff >= claim.amount_due {
                return Err(InvariantViolation {
                    invariant_name: "status_matches_amounts_v3",
                    message: format!(
                        "PartiallyPaid claim must have 0 < eff < amount_due: eff={}, amount_due={}",
                        eff, claim.amount_due
                    ),
                });
            }
        }
        Status::Paid => {
            if eff != claim.amount_due {
                return Err(InvariantViolation {
                    invariant_name: "status_matches_amounts_v3",
                    message: format!(
                        "Paid claim must have eff == amount_due: eff={}, amount_due={}",
                        eff, claim.amount_due
                    ),
                });
            }
        }
        Status::Cancelled => {
            if claim.distributed_total != 0 || claim.fee_total != 0 || claim.credit_total != 0 {
                return Err(InvariantViolation {
                    invariant_name: "status_matches_amounts_v3",
                    message: format!(
                        "Cancelled claim must have distributed == 0, fee == 0, credit == 0 (got distributed={}, fee={}, credit={})",
                        claim.distributed_total, claim.fee_total, claim.credit_total
                    ),
                });
            }
        }
        Status::Closed => {
            // Closed is reached either from Paid (eff == amount_due) or via writeoff from PartiallyPaid (0 < eff <= amount_due)
            if eff > claim.amount_due {
                return Err(InvariantViolation {
                    invariant_name: "status_matches_amounts_v3",
                    message: format!(
                        "Closed claim cannot have eff > amount_due: eff={}, amount_due={}",
                        eff, claim.amount_due
                    ),
                });
            }
        }
    }

    Ok(())
}

/// 4. `reconcile_idempotent`: repeated reconcile with zero delta changes nothing (Blueprint 2.5, 2.11).
pub fn check_reconcile_idempotent(prev: &Claim, curr: &Claim) -> Result<(), InvariantViolation> {
    if prev.booked_total != curr.booked_total
        || prev.distributed_total != curr.distributed_total
        || prev.fee_total != curr.fee_total
        || prev.surplus != curr.surplus
        || prev.credit_total != curr.credit_total
        || prev.status != curr.status
        || prev.lock != curr.lock
        || prev.last_seen_balance != curr.last_seen_balance
        || prev.undistributed != curr.undistributed
    {
        return Err(InvariantViolation {
            invariant_name: "reconcile_idempotent",
            message: "claim state changed after zero-delta reconcile".into(),
        });
    }

    Ok(())
}

/// 5. `fee_bounded`: protocol fee is bounded by 25 bps: `fee <= floor(payment * 25 / 10_000)` (Blueprint 2.1, 2.11).
pub fn check_fee_bounded(claim: &Claim) -> Result<(), InvariantViolation> {
    let payment_total = claim.booked_total.saturating_sub(claim.surplus);
    let max_expected_fee = (payment_total.saturating_mul(25)) / 10_000;

    // Protocol fee must never exceed the 25 bps upper bound (Blueprint 2.11).
    if claim.fee_total > max_expected_fee {
        return Err(InvariantViolation {
            invariant_name: "fee_bounded",
            message: format!(
                "fee_total ({}) exceeds upper bound ({}) for payment total ({})",
                claim.fee_total, max_expected_fee, payment_total
            ),
        });
    }

    Ok(())
}

/// 6. `failed_distribution_keeps_booking`: failed distribution never unbooks a payment (Blueprint 2.5, 2.11 D-S8).
pub fn check_failed_distribution_keeps_booking(
    pre_reconcile: &Claim,
    post_failed_reconcile: &Claim,
    booking_delta: u128,
) -> Result<(), InvariantViolation> {
    if post_failed_reconcile.booked_total < pre_reconcile.booked_total.saturating_add(booking_delta)
    {
        return Err(InvariantViolation {
            invariant_name: "failed_distribution_keeps_booking",
            message: format!(
                "booked_total unbooked after failed distribution: expected at least {}, got {}",
                pre_reconcile.booked_total + booking_delta,
                post_failed_reconcile.booked_total
            ),
        });
    }

    if post_failed_reconcile.undistributed.is_empty() {
        return Err(InvariantViolation {
            invariant_name: "failed_distribution_keeps_booking",
            message: "expected failed leg to be retained in undistributed".into(),
        });
    }

    Ok(())
}

/// 7. `undistributed_payee_fixed_at_booking`: undistributed legs retain their recorded receiver after owner transfer (Blueprint 2.5, 2.11 D-S8).
pub fn check_undistributed_payee_fixed_at_booking(
    original_legs: &[Leg],
    current_legs: &[Leg],
    new_owner: &str,
) -> Result<(), InvariantViolation> {
    for orig in original_legs {
        if let Leg::Pay {
            receiver: orig_receiver,
            amount,
            ..
        } = orig
        {
            // Find corresponding leg in current_legs
            let found = current_legs.iter().any(|curr| match curr {
                Leg::Pay {
                    receiver,
                    amount: curr_amt,
                    ..
                } => receiver == orig_receiver && curr_amt == amount,
                _ => false,
            });

            if !found {
                // If it was modified to new_owner, report violation!
                let changed_to_new_owner = current_legs.iter().any(|curr| match curr {
                    Leg::Pay { receiver, .. } => receiver == new_owner,
                    _ => false,
                });

                if changed_to_new_owner {
                    return Err(InvariantViolation {
                        invariant_name: "undistributed_payee_fixed_at_booking",
                        message: format!(
                            "undistributed leg payee was redirected to new owner '{}' instead of recorded '{}'",
                            new_owner, orig_receiver
                        ),
                    });
                }
            }
        }
    }

    Ok(())
}
