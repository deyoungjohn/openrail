use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use openrail_mock_intents::MockIntents;

fn set_context(predecessor: &str, deposit: u128) {
    let mut builder = VMContextBuilder::new();
    builder
        .predecessor_account_id(predecessor.parse().unwrap())
        .current_account_id("intents.near".parse().unwrap())
        .attached_deposit(near_sdk::NearToken::from_yoctonear(deposit));
    testing_env!(builder.build());
}

#[test]
fn test_uncreated_account_has_zero_balance() {
    set_context("alice.near", 0);
    let contract = MockIntents::default();
    let token = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near".to_string();
    assert_eq!(
        contract.mt_balance_of("uncreated.near".parse().unwrap(), token),
        U128(0)
    );
}

#[test]
fn test_mint_and_batch_balance() {
    set_context("alice.near", 0);
    let mut contract = MockIntents::default();
    let token1 = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near".to_string();
    let token2 = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near".to_string();

    contract.mt_mint("alice.near".parse().unwrap(), token1.clone(), U128(500));
    contract.mt_mint("alice.near".parse().unwrap(), token2.clone(), U128(300));

    assert_eq!(
        contract.mt_balance_of("alice.near".parse().unwrap(), token1.clone()),
        U128(500)
    );
    assert_eq!(
        contract.mt_balance_of("alice.near".parse().unwrap(), token2.clone()),
        U128(300)
    );

    let batch = contract.mt_batch_balance_of(
        "alice.near".parse().unwrap(),
        vec![token1, token2, "nep141:sol-unknown".to_string()],
    );
    assert_eq!(batch, vec![U128(500), U128(300), U128(0)]);
}

#[test]
fn test_transfer_to_uncreated_account() {
    set_context("alice.near", 0);
    let mut contract = MockIntents::default();
    let token = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near".to_string();

    contract.mt_mint("alice.near".parse().unwrap(), token.clone(), U128(1_000));

    // Must attach 1 yocto
    set_context("alice.near", 1);
    contract.mt_transfer(
        "claim-1.openrail.near".parse().unwrap(),
        token.clone(),
        U128(600),
        None,
        Some("funding invoice".to_string()),
    );

    assert_eq!(
        contract.mt_balance_of("alice.near".parse().unwrap(), token.clone()),
        U128(400)
    );
    // Uncreated claim subaccount holds balance
    assert_eq!(
        contract.mt_balance_of("claim-1.openrail.near".parse().unwrap(), token),
        U128(600)
    );
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn test_transfer_requires_one_yocto() {
    set_context("alice.near", 0);
    let mut contract = MockIntents::default();
    let token = "nep141:test".to_string();
    contract.mt_mint("alice.near".parse().unwrap(), token.clone(), U128(100));
    contract.mt_transfer("bob.near".parse().unwrap(), token, U128(50), None, None);
}

#[test]
#[should_panic(expected = "intents mock: insufficient balance")]
fn test_transfer_insufficient_balance() {
    set_context("alice.near", 1);
    let mut contract = MockIntents::default();
    let token = "nep141:test".to_string();
    contract.mt_mint("alice.near".parse().unwrap(), token.clone(), U128(50));
    contract.mt_transfer("bob.near".parse().unwrap(), token, U128(100), None, None);
}
