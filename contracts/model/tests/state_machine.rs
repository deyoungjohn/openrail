use openrail_model::*;

#[test]
fn test_issue_and_ack_near() {
    let mut model = Model::new();
    let debtor = Debtor::Near("debtor.near".to_string());
    let token_id = "c-1".to_string();

    let events = model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: "issuer.near".to_string(),
                debtor: Some(debtor),
                terms_hash: Hex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .expect("issue should succeed");

    assert_eq!(events.len(), 1);
    assert_eq!(model.get_claim(&token_id).unwrap().status, Status::Issued);

    // Wrong signer fails
    let err = model
        .step(
            Action::AcknowledgeNear {
                token_id: token_id.clone(),
                caller: "impostor.near".to_string(),
            },
            101,
        )
        .unwrap_err();
    assert_eq!(err, ModelError::InvalidSigner);

    // Correct debtor acknowledges
    let events = model
        .step(
            Action::AcknowledgeNear {
                token_id: token_id.clone(),
                caller: "debtor.near".to_string(),
            },
            102,
        )
        .expect("ack should succeed");
    assert_eq!(events.len(), 1);
    assert!(model.get_claim(&token_id).unwrap().ack.is_some());

    // Second ack rejected (write-once)
    let err = model
        .step(
            Action::AcknowledgeNear {
                token_id: token_id.clone(),
                caller: "debtor.near".to_string(),
            },
            103,
        )
        .unwrap_err();
    assert_eq!(err, ModelError::AlreadyAcknowledged);
}

#[test]
fn test_reconcile_booking_arithmetic_and_fee() {
    let mut model = Model::new();
    let token_id = "c-1".to_string();
    let asset = "nep141:usdc.near".to_string();

    model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: "issuer.near".to_string(),
                debtor: Some(Debtor::Near("debtor.near".to_string())),
                terms_hash: Hex32::default(),
                amount_due: 1_000_000, // 1 USDC ($1)
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    // Payer deposits 400_000 base units ($0.40)
    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: asset.clone(),
                amount: 400_000,
            },
            101,
        )
        .unwrap();

    // Reconcile: payment = 400_000. fee = 400_000 * 25 / 10_000 = 1_000 (25 bps). net = 399_000.
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
    assert_eq!(claim.booked_total, 400_000);
    assert_eq!(claim.fee_total, 1_000);
    assert_eq!(claim.distributed_total, 399_000);
    assert_eq!(claim.surplus, 0);
    assert_eq!(claim.status, Status::PartiallyPaid);
    assert_eq!(claim.outstanding(), 600_000);
    check_conservation_v3(claim).unwrap();
    check_status_matches_amounts_v3(claim).unwrap();
    check_fee_bounded(claim).unwrap();

    // Idempotent reconcile: zero delta changes nothing
    let prev = claim.clone();
    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![],
            },
            103,
        )
        .unwrap();
    let curr = model.get_claim(&token_id).unwrap();
    check_reconcile_idempotent(&prev, curr).unwrap();

    // Payer pays 800_000 ($0.80), which exceeds outstanding (600_000) by 200_000 ($0.20 surplus)
    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: asset.clone(),
                amount: 800_000,
            },
            104,
        )
        .unwrap();

    // payment = 600_000, surplus = 200_000.
    // fee on payment = 600_000 * 25 / 10_000 = 1_500. net = 598_500.
    // No fee on surplus!
    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![false, false],
            },
            105,
        )
        .unwrap();

    let claim = model.get_claim(&token_id).unwrap();
    assert_eq!(claim.booked_total, 1_200_000);
    assert_eq!(claim.surplus, 200_000);
    assert_eq!(claim.fee_total, 2_500); // 1_000 + 1_500
    assert_eq!(claim.distributed_total, 997_500); // 399_000 + 598_500
    assert_eq!(claim.status, Status::Paid);
    assert_eq!(claim.outstanding(), 0);
    check_conservation_v3(claim).unwrap();
    check_status_matches_amounts_v3(claim).unwrap();
    check_fee_bounded(claim).unwrap();
}

#[test]
fn test_transfer_rules_1_to_8() {
    let mut model = Model::new();
    let token_id = "c-1".to_string();
    let debtor = Debtor::Near("debtor.near".to_string());

    model
        .step(
            Action::Issue {
                token_id: token_id.clone(),
                kind: 0,
                issuer_id: "issuer.near".to_string(),
                debtor: Some(debtor),
                terms_hash: Hex32::default(),
                amount_due: 1_000_000,
                due_date: 1_800_000_000,
            },
            100,
        )
        .unwrap();

    let memo = Some(Hex32::new([1u8; 32]));

    // Transfer Rule 3 violation: unacknowledged claim cannot be sold
    let err = model
        .step(
            Action::Transfer {
                caller: "issuer.near".to_string(),
                token_id: token_id.clone(),
                new_owner: "buyer.near".to_string(),
                memo_assignment_doc_hash: memo,
                attached_yocto: 1,
            },
            101,
        )
        .unwrap_err();
    assert_eq!(
        err,
        ModelError::TransferRuleViolation(3, "unacknowledged claim cannot be sold".into())
    );

    // Acknowledge claim
    model
        .step(
            Action::AcknowledgeNear {
                token_id: token_id.clone(),
                caller: "debtor.near".to_string(),
            },
            102,
        )
        .unwrap();

    // Transfer Rule 4 violation: memo assignment doc hash required on sale
    let err = model
        .step(
            Action::Transfer {
                caller: "issuer.near".to_string(),
                token_id: token_id.clone(),
                new_owner: "buyer.near".to_string(),
                memo_assignment_doc_hash: None,
                attached_yocto: 1,
            },
            103,
        )
        .unwrap_err();
    assert_eq!(
        err,
        ModelError::TransferRuleViolation(4, "assignment document hash required on sale".into())
    );

    // Transfer Rule 5 violation: receiver cannot be claim account
    let claim_acc = model.get_claim(&token_id).unwrap().claim_account.clone();
    let err = model
        .step(
            Action::Transfer {
                caller: "issuer.near".to_string(),
                token_id: token_id.clone(),
                new_owner: claim_acc,
                memo_assignment_doc_hash: memo,
                attached_yocto: 1,
            },
            104,
        )
        .unwrap_err();
    assert_eq!(
        err,
        ModelError::TransferRuleViolation(5, "receiver cannot be claim account".into())
    );

    // Transfer Rule 6 violation: attached yocto must be exactly 1
    let err = model
        .step(
            Action::Transfer {
                caller: "issuer.near".to_string(),
                token_id: token_id.clone(),
                new_owner: "buyer.near".to_string(),
                memo_assignment_doc_hash: memo,
                attached_yocto: 0,
            },
            105,
        )
        .unwrap_err();
    assert_eq!(
        err,
        ModelError::TransferRuleViolation(6, "exactly 1 yocto must be attached".into())
    );

    // Valid transfer succeeds
    model
        .step(
            Action::Transfer {
                caller: "issuer.near".to_string(),
                token_id: token_id.clone(),
                new_owner: "buyer.near".to_string(),
                memo_assignment_doc_hash: memo,
                attached_yocto: 1,
            },
            106,
        )
        .expect("transfer should succeed");

    assert_eq!(model.get_claim(&token_id).unwrap().owner_id, "buyer.near");
}

#[test]
fn test_ds8_failed_distribution_and_retry() {
    let mut model = Model::new();
    let token_id = "c-1".to_string();
    let asset = "nep141:usdc.near".to_string();

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
                asset: asset.clone(),
                amount: 500_000,
            },
            102,
        )
        .unwrap();

    let pre_reconcile = model.get_claim(&token_id).unwrap().clone();

    // Reconcile with distribution failure: owner leg fails (leg 0), fee succeeds (leg 1)
    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![true, false],
            },
            103,
        )
        .unwrap();

    let post_failed = model.get_claim(&token_id).unwrap().clone();

    // Invariant: failed distribution keeps booking!
    check_failed_distribution_keeps_booking(&pre_reconcile, &post_failed, 500_000).unwrap();
    assert_eq!(post_failed.booked_total, 500_000);
    assert_eq!(post_failed.status, Status::PartiallyPaid);
    assert_eq!(post_failed.undistributed.len(), 1);

    // Undistributed leg recorded payee is "seller.near"
    assert_eq!(
        post_failed.undistributed[0].receiver(),
        Some(&"seller.near".to_string())
    );

    // Now seller sells the invoice to buyer
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

    let post_transfer = model.get_claim(&token_id).unwrap();
    assert_eq!(post_transfer.owner_id, "buyer.near");

    // Invariant: undistributed leg payee remains fixed at booking to seller.near!
    check_undistributed_payee_fixed_at_booking(
        &post_failed.undistributed,
        &post_transfer.undistributed,
        "buyer.near",
    )
    .unwrap();

    // Retry distribution succeeds
    let events = model
        .step(
            Action::RetryDistribution {
                token_id: token_id.clone(),
                leg_failures: vec![false],
            },
            105,
        )
        .unwrap();

    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::Distributed { leg, .. } => {
            assert_eq!(leg.receiver(), Some(&"seller.near".to_string()));
        }
        _ => panic!("expected Distributed event"),
    }

    assert!(model.get_claim(&token_id).unwrap().undistributed.is_empty());
}

#[test]
fn test_anomaly_drain_balance_and_reset_last_seen() {
    let mut model = Model::new();
    let token_id = "c-anomaly".to_string();
    let asset = "nep141:usdc.near".to_string();

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
            Action::AcknowledgeNear {
                token_id: token_id.clone(),
                caller: "debtor.near".to_string(),
            },
            100,
        )
        .unwrap();

    // Deposit 500_000
    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: asset.clone(),
                amount: 500_000,
            },
            101,
        )
        .unwrap();

    // Reconcile with failed distribution: books 500_000, funds stay in sub-account so last_seen = 500_000
    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![true, true],
            },
            102,
        )
        .unwrap();

    let claim = model.get_claim(&token_id).unwrap();
    assert_eq!(claim.booked_total, 500_000);
    assert_eq!(*claim.last_seen_balance.get(&asset).unwrap(), 500_000);

    // Balance anomaly: intents balance drained by 200_000 (curr_balance = 300_000 < last_seen 500_000)
    model
        .step(
            Action::DrainIntentsBalance {
                token_id: token_id.clone(),
                asset: asset.clone(),
                amount: 200_000,
            },
            103,
        )
        .unwrap();

    // Reconcile detects anomaly: emits Event::Anomaly, treats delta as 0, resets last_seen to 300_000
    let events = model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![true, true],
            },
            104,
        )
        .unwrap();

    let found_anomaly = events.iter().any(|e| matches!(e, Event::Anomaly { .. }));
    assert!(
        found_anomaly,
        "Reconcile must emit Event::Anomaly when balance falls below last_seen"
    );

    let claim_after_anomaly = model.get_claim(&token_id).unwrap();
    assert_eq!(
        claim_after_anomaly.booked_total, 500_000,
        "anomaly delta must be 0"
    );
    assert_eq!(
        *claim_after_anomaly.last_seen_balance.get(&asset).unwrap(),
        300_000,
        "last_seen must be reset to curr_balance"
    );

    // Next deposit of 400_000 (balance goes from 300_000 to 700_000)
    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: asset.clone(),
                amount: 400_000,
            },
            105,
        )
        .unwrap();

    // Reconcile books delta = 700_000 - 300_000 = 400_000
    model
        .step(
            Action::Reconcile {
                token_id: token_id.clone(),
                leg_failures: vec![true, true],
            },
            106,
        )
        .unwrap();

    let claim_after_deposit = model.get_claim(&token_id).unwrap();
    assert_eq!(
        claim_after_deposit.booked_total, 900_000,
        "only new deposit amount should be booked after anomaly"
    );
    assert_eq!(
        *claim_after_deposit.last_seen_balance.get(&asset).unwrap(),
        700_000
    );
}

#[test]
fn test_reconcile_start_interleaving_and_callback_failure() {
    let mut model = Model::new();
    let token_id = "c-two-phase".to_string();
    let asset = "nep141:usdc.near".to_string();

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
            Action::AcknowledgeNear {
                token_id: token_id.clone(),
                caller: "debtor.near".to_string(),
            },
            100,
        )
        .unwrap();

    model
        .step(
            Action::DepositIntentsBalance {
                token_id: token_id.clone(),
                asset: asset.clone(),
                amount: 300_000,
            },
            101,
        )
        .unwrap();

    // Start reconcile
    let start_events = model
        .step(
            Action::ReconcileStart {
                token_id: token_id.clone(),
            },
            102,
        )
        .unwrap();

    assert_eq!(
        start_events,
        vec![Event::ReconcileStarted {
            token_id: token_id.clone()
        }]
    );
    assert!(matches!(
        model.get_claim(&token_id).unwrap().lock,
        Lock::Reconciling { since: 102 }
    ));

    // Transfer fails under Reconciling lock (Transfer rule 1)
    let transfer_err = model
        .step(
            Action::Transfer {
                caller: "issuer.near".to_string(),
                token_id: token_id.clone(),
                new_owner: "buyer.near".to_string(),
                memo_assignment_doc_hash: None,
                attached_yocto: 1,
            },
            103,
        )
        .unwrap_err();
    assert_eq!(
        transfer_err,
        ModelError::TransferRuleViolation(1, "lock must be None or TransferWindow".to_string())
    );

    // Cancel fails under Reconciling lock
    let cancel_err = model
        .step(
            Action::Cancel {
                caller: "issuer.near".to_string(),
                token_id: token_id.clone(),
                debtor_cosig: None,
            },
            103,
        )
        .unwrap_err();
    assert_eq!(cancel_err, ModelError::CancelDisallowed);

    // Second ReconcileStart fails under Reconciling lock
    let second_start_err = model
        .step(
            Action::ReconcileStart {
                token_id: token_id.clone(),
            },
            103,
        )
        .unwrap_err();
    assert!(matches!(second_start_err, ModelError::ClaimLocked(_)));

    // Callback fails: callback_ok = false
    let cb_events = model
        .step(
            Action::ReconcileCallback {
                token_id: token_id.clone(),
                leg_failures: vec![],
                callback_ok: false,
            },
            104,
        )
        .unwrap();

    assert_eq!(
        cb_events,
        vec![Event::ReconcileFailed {
            token_id: token_id.clone()
        }]
    );
    let claim_after_failure = model.get_claim(&token_id).unwrap();
    assert_eq!(
        claim_after_failure.lock,
        Lock::None,
        "lock must be restored to previous lock"
    );
    assert_eq!(
        claim_after_failure.booked_total, 0,
        "no payment booked on failed callback"
    );

    // After failure restores lock, transfer succeeds!
    let transfer_events = model
        .step(
            Action::Transfer {
                caller: "issuer.near".to_string(),
                token_id: token_id.clone(),
                new_owner: "buyer.near".to_string(),
                memo_assignment_doc_hash: Some(Hex32::default()),
                attached_yocto: 1,
            },
            105,
        )
        .unwrap();
    assert_eq!(transfer_events.len(), 1);
    assert_eq!(model.get_claim(&token_id).unwrap().owner_id, "buyer.near");
}
