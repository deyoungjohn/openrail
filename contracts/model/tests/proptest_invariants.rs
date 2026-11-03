use openrail_model::strategy::*;
use openrail_model::*;
use proptest::prelude::*;

fn config() -> ProptestConfig {
    let cases = std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(1000);
    ProptestConfig {
        cases,
        ..ProptestConfig::default()
    }
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn test_scenario_invariants((issue_action, actions) in arb_scenario()) {
        let mut model = Model::new();
        let mut block = 100u64;

        // Step 1: Issue
        let token_id = match &issue_action {
            Action::Issue { token_id, .. } => token_id.clone(),
            _ => unreachable!(),
        };

        model.step(issue_action, block).expect("issue should succeed");
        let mut prev_claim = model.get_claim(&token_id).unwrap().clone();
        check_conservation_v3(&prev_claim).unwrap();
        check_status_matches_amounts_v3(&prev_claim).unwrap();
        check_no_self_ownership(&prev_claim).unwrap();
        check_only_settlement_assets_count(&prev_claim).unwrap();

        let mut pre_reconcile_claim: Option<Claim> = None;

        // Step 2: Run sequence of interleaved actions
        for action in actions {
            block += 10;
            let action_clone = action.clone();

            let res = model.step(action, block);

            if let Ok(events) = res {
                let curr_claim = model.get_claim(&token_id).unwrap().clone();
                let released = model.released_surplus(&token_id);

                // Fundamental invariants after every state transition
                check_conservation_v3_with_released(&curr_claim, released).unwrap();
                check_counters_monotonic(&prev_claim, &curr_claim).unwrap();
                check_status_matches_amounts_v3_with_released(&curr_claim, released).unwrap();
                check_fee_bounded(&curr_claim).unwrap();
                check_transitions_enforced(prev_claim.status, curr_claim.status).unwrap();
                check_only_settlement_assets_count(&curr_claim).unwrap();
                check_no_self_ownership(&curr_claim).unwrap();
                check_cancel_only_unpaid(&curr_claim).unwrap();

                // Reconcile checks
                match action_clone {
                    Action::ReconcileStart { .. } => {
                        pre_reconcile_claim = Some(prev_claim.clone());
                    }
                    Action::ReconcileCallback { .. } => {
                        if let Some(pre_claim) = pre_reconcile_claim.take() {
                            if pre_claim.last_seen_balance == curr_claim.last_seen_balance
                                && pre_claim.booked_total == curr_claim.booked_total
                                && !events.iter().any(|e| matches!(e, Event::Anomaly { .. }))
                            {
                                check_reconcile_idempotent(&pre_claim, &curr_claim).unwrap();
                            }
                        }

                        // Check D-S8 failed distribution if any leg failed
                        if events.iter().any(|e| matches!(e, Event::DistributionFailed { .. })) {
                            let delta = curr_claim.booked_total.saturating_sub(prev_claim.booked_total);
                            check_failed_distribution_keeps_booking(&prev_claim, &curr_claim, delta).unwrap();
                        }

                        // Check closed addresses stay live on stray payments
                        if prev_claim.status.is_terminal() {
                            let delta = curr_claim.booked_total.saturating_sub(prev_claim.booked_total);
                            check_closed_addresses_stay_live(&prev_claim, &curr_claim, delta).unwrap();
                        }
                    }
                    Action::Reconcile { .. } => {
                        // Check if delta was zero and no anomaly
                        if prev_claim.last_seen_balance == curr_claim.last_seen_balance
                            && prev_claim.booked_total == curr_claim.booked_total
                            && !events.iter().any(|e| matches!(e, Event::Anomaly { .. }))
                        {
                            check_reconcile_idempotent(&prev_claim, &curr_claim).unwrap();
                        }

                        // Check D-S8 failed distribution if any leg failed
                        if events.iter().any(|e| matches!(e, Event::DistributionFailed { .. })) {
                            let delta = curr_claim.booked_total.saturating_sub(prev_claim.booked_total);
                            check_failed_distribution_keeps_booking(&prev_claim, &curr_claim, delta).unwrap();
                        }

                        // Check closed addresses stay live on stray payments
                        if prev_claim.status.is_terminal() {
                            let delta = curr_claim.booked_total.saturating_sub(prev_claim.booked_total);
                            check_closed_addresses_stay_live(&prev_claim, &curr_claim, delta).unwrap();
                        }
                    }
                    _ => {}
                }

                // Transfer specific checks
                if let Action::Transfer { ref new_owner, .. } = action_clone {
                    check_no_transfer_under_lock(&prev_claim).unwrap();
                    check_no_transfer_when_settled(&prev_claim).unwrap();
                    check_undistributed_payee_fixed_at_booking(
                        &prev_claim.undistributed,
                        &curr_claim.undistributed,
                        new_owner,
                    )
                    .unwrap();
                }

                // Clear stale lock check
                if let Action::ClearStaleLock { .. } = action_clone {
                    check_stale_reconcile_lock_clears(&prev_claim.lock, &curr_claim.lock, block).unwrap();
                }

                prev_claim = curr_claim;
            }
        }
    }
}
