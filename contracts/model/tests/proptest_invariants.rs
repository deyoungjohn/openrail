use openrail_model::strategy::*;
use openrail_model::*;
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

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

        // Step 2: Run sequence of interleaved actions
        for action in actions {
            block += 10;
            let action_clone = action.clone();

            let res = model.step(action, block);

            if let Ok(events) = res {
                let curr_claim = model.get_claim(&token_id).unwrap().clone();
                let released = model.released_surplus(&token_id);

                // Check fundamental invariants after every successful step
                check_conservation_v3_with_released(&curr_claim, released).unwrap();
                check_counters_monotonic(&prev_claim, &curr_claim).unwrap();
                check_status_matches_amounts_v3_with_released(&curr_claim, released).unwrap();
                check_fee_bounded(&curr_claim).unwrap();

                // Reconcile specific checks
                if let Action::Reconcile { .. } = action_clone {
                    // Check if delta was zero
                    if prev_claim.last_seen_balance == curr_claim.last_seen_balance
                        && prev_claim.booked_total == curr_claim.booked_total
                    {
                        check_reconcile_idempotent(&prev_claim, &curr_claim).unwrap();
                    }

                    // Check D-S8 failed distribution if any leg failed
                    if events.iter().any(|e| matches!(e, Event::DistributionFailed { .. })) {
                        let delta = curr_claim.booked_total.saturating_sub(prev_claim.booked_total);
                        check_failed_distribution_keeps_booking(&prev_claim, &curr_claim, delta).unwrap();
                    }
                }

                // Transfer specific check: undistributed payee fixed at booking
                if let Action::Transfer { ref new_owner, .. } = action_clone {
                    check_undistributed_payee_fixed_at_booking(
                        &prev_claim.undistributed,
                        &curr_claim.undistributed,
                        new_owner,
                    )
                    .unwrap();
                }

                prev_claim = curr_claim;
            }
        }
    }
}
