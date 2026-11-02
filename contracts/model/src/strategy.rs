//! Proptest strategies for fuzz testing the Openrail reference model.

use crate::actions::Action;
use crate::types::{Debtor, Hex20, Hex32};
use proptest::prelude::*;

/// Generates arbitrary 32-byte Hex32.
pub fn arb_hex32() -> impl Strategy<Value = Hex32> {
    prop::array::uniform32(any::<u8>()).prop_map(Hex32)
}

/// Generates arbitrary 20-byte Hex20 EVM address.
pub fn arb_hex20() -> impl Strategy<Value = Hex20> {
    prop::array::uniform20(any::<u8>()).prop_map(Hex20)
}

/// Generates arbitrary Debtor.
pub fn arb_debtor() -> impl Strategy<Value = Debtor> {
    prop_oneof![
        arb_hex20().prop_map(Debtor::Evm),
        prop::sample::select(vec![
            "debtor1.near".to_string(),
            "debtor2.near".to_string(),
            "business.near".to_string(),
        ])
        .prop_map(Debtor::Near),
    ]
}

/// Generates arbitrary actions for a single claim ID `token_id`.
pub fn arb_action_for_token(token_id: String) -> impl Strategy<Value = Action> {
    let t1 = token_id.clone();
    let t2 = token_id.clone();
    let t3 = token_id.clone();
    let t4 = token_id.clone();
    let t5 = token_id.clone();
    let t6 = token_id.clone();
    let t7 = token_id.clone();
    let t8 = token_id.clone();
    let t9 = token_id.clone();
    let t10 = token_id.clone();
    let t11 = token_id.clone();
    let t12 = token_id.clone();

    let assets = vec![
        "nep141:usdc.near".to_string(),
        "nep141:usdc.base".to_string(),
        "nep141:usdc.arb".to_string(),
        "nep141:usdc.eth".to_string(),
    ];

    prop_oneof![
        // Ack NEAR
        Just(t1).prop_map(|id| Action::AcknowledgeNear {
            token_id: id,
            caller: "debtor1.near".to_string(),
        }),
        // Ack EVM
        (Just(t2), arb_hex20()).prop_map(|(id, signer)| Action::AcknowledgeEvm {
            token_id: id,
            chain_id: 8453,
            signer,
        }),
        // Deposit balance (1..=2_000_000 USDC base units)
        (
            Just(t3),
            prop::sample::select(assets),
            1u128..=2_000_000u128
        )
            .prop_map(|(id, asset, amount)| Action::DepositIntentsBalance {
                token_id: id,
                asset,
                amount,
            }),
        // Prepare transfer
        Just(t4).prop_map(|id| Action::PrepareTransfer {
            token_id: id,
            caller: "issuer.near".to_string(),
        }),
        // Transfer
        (
            Just(t5),
            prop::sample::select(vec![
                "buyer1.near".to_string(),
                "buyer2.near".to_string(),
                "issuer.near".to_string(),
            ]),
            proptest::option::of(arb_hex32()),
            prop::sample::select(vec![0u128, 1u128]),
        )
            .prop_map(|(id, new_owner, memo, attached_yocto)| Action::Transfer {
                caller: "issuer.near".to_string(),
                token_id: id,
                new_owner,
                memo_assignment_doc_hash: memo,
                attached_yocto,
            }),
        // Reconcile with random leg outcomes
        (Just(t6), prop::collection::vec(any::<bool>(), 0..=3)).prop_map(|(id, leg_failures)| {
            Action::Reconcile {
                token_id: id,
                leg_failures,
            }
        }),
        // Retry distribution
        (Just(t7), prop::collection::vec(any::<bool>(), 0..=3)).prop_map(|(id, leg_failures)| {
            Action::RetryDistribution {
                token_id: id,
                leg_failures,
            }
        }),
        // Clear stale lock
        Just(t8).prop_map(|id| Action::ClearStaleLock { token_id: id }),
        // Cancel
        Just(t9).prop_map(|id| Action::Cancel {
            caller: "issuer.near".to_string(),
            token_id: id,
            debtor_cosig: None,
        }),
        // Close
        Just(t10).prop_map(|id| Action::Close {
            caller: "issuer.near".to_string(),
            token_id: id,
        }),
        // Close writeoff
        Just(t11).prop_map(|id| Action::CloseWriteoff {
            caller: "issuer.near".to_string(),
            token_id: id,
        }),
        // Release surplus
        Just(t12).prop_map(|id| Action::ReleaseSurplus {
            caller: "issuer.near".to_string(),
            token_id: id,
        }),
    ]
}

/// Generates a complete sequence of interleaved actions for a claim.
pub fn arb_scenario() -> impl Strategy<Value = (Action, Vec<Action>)> {
    let token_id = "c-1".to_string();
    let issue_action = (
        Just(token_id.clone()),
        arb_debtor(),
        arb_hex32(),
        100_000u128..=10_000_000u128,
        any::<u64>(),
    )
        .prop_map(
            |(id, debtor, terms_hash, amount_due, due_date)| Action::Issue {
                token_id: id,
                kind: 0,
                issuer_id: "issuer.near".to_string(),
                debtor: Some(debtor),
                terms_hash,
                amount_due,
                due_date,
            },
        );

    (
        issue_action,
        prop::collection::vec(arb_action_for_token(token_id), 1..=40),
    )
}
