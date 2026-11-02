//! 5 Deliberate mutation checks proving the invariant checkers catch model breaks.

use openrail_model::*;

/// Mutant 1: Wrong protocol fee calculation (e.g. 20 bps instead of 25 bps).
/// Proves that `check_fee_bounded` catches incorrect fee calculation.
#[test]
fn test_mutation_1_wrong_fee_rate_caught_by_fee_bounded() {
    let mut model = Model::with_mutations(Mutations {
        wrong_fee_rate: true,
        ..Default::default()
    });
    let token_id = "c-m1".to_string();

    model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: "issuer.near".to_string(),
                debtor: Some(Debtor::Near("debtor.near".to_string())),
                terms_hash: Hex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: "nep141:usdc.near".to_string(),
                amount: 1_000_000,
            },
            101,
        )
        .unwrap();

    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![false, false],
            },
            102,
        )
        .unwrap();

    let claim = model.get_claim(&token_id).unwrap();
    // In mutant 1, fee is off-by-one: 2_501 instead of 2_500.
    assert_eq!(claim.fee_total, 2_501);

    // Invariant check MUST fail!
    let err = check_fee_bounded(claim).expect_err("mutant 1 must be caught by fee_bounded");
    assert_eq!(err.invariant_name, "fee_bounded");
}

/// Mutant 2: Booking is unbooked if distribution leg fails (violating D-S8).
/// Proves that `check_failed_distribution_keeps_booking` catches reverted bookings.
#[test]
fn test_mutation_2_unbook_on_failed_distribution_caught() {
    let mut model = Model::with_mutations(Mutations {
        unbook_on_failed_distribution: true,
        ..Default::default()
    });
    let token_id = "c-m2".to_string();

    model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: "issuer.near".to_string(),
                debtor: Some(Debtor::Near("debtor.near".to_string())),
                terms_hash: Hex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: "nep141:usdc.near".to_string(),
                amount: 500_000,
            },
            101,
        )
        .unwrap();

    let pre_reconcile = model.get_claim(&token_id).unwrap().clone();

    // Reconcile with failed leg
    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![true, false],
            },
            102,
        )
        .unwrap();

    let post_reconcile = model.get_claim(&token_id).unwrap().clone();

    // Invariant check MUST fail!
    let err = check_failed_distribution_keeps_booking(&pre_reconcile, &post_reconcile, 500_000)
        .expect_err("mutant 2 must be caught by failed_distribution_keeps_booking");
    assert_eq!(err.invariant_name, "failed_distribution_keeps_booking");
}

/// Mutant 3: Transfer rewires undistributed legs to the new buyer (violating D-S8).
/// Proves that `check_undistributed_payee_fixed_at_booking` catches redirected payees.
#[test]
fn test_mutation_3_transfer_updates_undistributed_payee_caught() {
    let mut model = Model::with_mutations(Mutations {
        transfer_updates_undistributed_payee: true,
        ..Default::default()
    });
    let token_id = "c-m3".to_string();

    model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: "seller.near".to_string(),
                debtor: Some(Debtor::Near("debtor.near".to_string())),
                terms_hash: Hex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    model
        .step(
            Action::AcknowledgeNear {
                token_id: token_id.clone(),
                caller: "debtor.near".to_string(),
            },
            101,
        )
        .unwrap();

    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: "nep141:usdc.near".to_string(),
                amount: 500_000,
            },
            102,
        )
        .unwrap();

    // Reconcile with failed leg, recording "seller.near"
    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![true, false],
            },
            103,
        )
        .unwrap();

    let pre_transfer_legs = model.get_claim(&token_id).unwrap().undistributed.clone();

    // Transfer claim to "buyer.near"
    model
        .step(
            Action::Transfer {
                caller: "seller.near".to_string(),
                token_id: token_id.clone(),
                new_owner: "buyer.near".to_string(),
                memo_assignment_doc_hash: Some(Hex32::default()),
                attached_yocto: 1,
            },
            104,
        )
        .unwrap();

    let post_transfer_legs = model.get_claim(&token_id).unwrap().undistributed.clone();

    // Invariant check MUST fail!
    let err = check_undistributed_payee_fixed_at_booking(
        &pre_transfer_legs,
        &post_transfer_legs,
        "buyer.near",
    )
    .expect_err("mutant 3 must be caught by undistributed_payee_fixed_at_booking");
    assert_eq!(err.invariant_name, "undistributed_payee_fixed_at_booking");
}

/// Mutant 4: A counter is decremented during writeoff.
/// Proves that `check_counters_monotonic` catches decreasing counters.
#[test]
fn test_mutation_4_counter_decrement_caught_by_monotonicity() {
    let mut model = Model::with_mutations(Mutations {
        allow_counter_decrement: true,
        ..Default::default()
    });
    let token_id = "c-m4".to_string();

    model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: "owner.near".to_string(),
                debtor: Some(Debtor::Near("debtor.near".to_string())),
                terms_hash: Hex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: "nep141:usdc.near".to_string(),
                amount: 500_000,
            },
            101,
        )
        .unwrap();

    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![false, false],
            },
            102,
        )
        .unwrap();

    let prev = model.get_claim(&token_id).unwrap().clone();

    // Close writeoff decrements booked_total in mutant 4
    model
        .step(
            Action::CloseWriteoff {
                caller: "owner.near".to_string(),
                token_id: token_id.clone(),
            },
            103,
        )
        .unwrap();

    let curr = model.get_claim(&token_id).unwrap();

    // Invariant check MUST fail!
    let err = check_counters_monotonic(&prev, curr)
        .expect_err("mutant 4 must be caught by counters_monotonic");
    assert_eq!(err.invariant_name, "counters_monotonic");
}

/// Mutant 5: Conservation violation by dropping protocol fee from accounting.
/// Proves that `check_conservation_v3` catches accounting imbalances.
#[test]
fn test_mutation_5_broken_conservation_caught() {
    let mut model = Model::with_mutations(Mutations {
        broken_conservation: true,
        ..Default::default()
    });
    let token_id = "c-m5".to_string();

    model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: "issuer.near".to_string(),
                debtor: Some(Debtor::Near("debtor.near".to_string())),
                terms_hash: Hex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: "nep141:usdc.near".to_string(),
                amount: 1_000_000,
            },
            101,
        )
        .unwrap();

    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![false, false],
            },
            102,
        )
        .unwrap();

    let claim = model.get_claim(&token_id).unwrap();

    // Invariant check MUST fail!
    let err = check_conservation_v3(claim).expect_err("mutant 5 must be caught by conservation_v3");
    assert_eq!(err.invariant_name, "conservation_v3");
}
