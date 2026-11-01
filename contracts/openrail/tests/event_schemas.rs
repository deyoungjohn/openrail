//! Test event schemas validate sample events (Prompt P0.3 item 6).

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use openrail::events::*;
use openrail::types::{AckScheme, Debtor, Leg, Lock};
use std::fs;
use std::path::Path;

fn load_schema(name: &str) -> Value {
    let p1 = format!("../../schemas/events/{}.schema.json", name);
    let p2 = format!("schemas/events/{}.schema.json", name);
    let path = if Path::new(&p1).exists() { p1 } else { p2 };
    let content = fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("Failed to read schema file at {}", path));
    serde_json::from_str(&content).expect("Invalid JSON schema")
}

fn validate_event_against_schema(event_name: &str, payload: Value) {
    let schema = load_schema(event_name);

    assert_eq!(
        payload.get("standard").and_then(Value::as_str),
        schema
            .get("properties")
            .and_then(|p| p.get("standard"))
            .and_then(|s| s.get("const"))
            .and_then(Value::as_str)
    );
    assert_eq!(
        payload.get("version").and_then(Value::as_str),
        Some("1.0.0")
    );
    assert_eq!(
        payload.get("event").and_then(Value::as_str),
        Some(event_name)
    );

    let data_arr = payload
        .get("data")
        .and_then(Value::as_array)
        .expect("data must be array");
    assert!(!data_arr.is_empty(), "data array must not be empty");

    let item = &data_arr[0];
    let items_schema = schema
        .get("properties")
        .and_then(|p| p.get("data"))
        .and_then(|d| d.get("items"))
        .expect("items schema missing");

    let required = items_schema
        .get("required")
        .and_then(Value::as_array)
        .expect("required array missing in schema");

    for req in required {
        let field_name = req.as_str().unwrap();
        assert!(
            item.get(field_name).is_some(),
            "Required field {} missing from sample event {}",
            field_name,
            event_name
        );
    }
}

#[test]
fn test_all_19_event_schemas_exist_and_validate() {
    let events = [
        "issue",
        "ack",
        "quote_logged",
        "booked",
        "distributed",
        "distribution_failed",
        "surplus",
        "surplus_released",
        "unmatched",
        "anomaly",
        "transfer_window",
        "cancel",
        "close",
        "writeoff",
        "lock_cleared",
        "config_changed",
        "reconcile_failed",
        "nft_mint",
        "nft_transfer",
    ];

    for name in events {
        let schema = load_schema(name);
        assert_eq!(
            schema.get("type").and_then(Value::as_str),
            Some("object"),
            "Schema {} root must be object",
            name
        );
    }
}

#[test]
fn test_sample_events_validate_against_schemas() {
    // 1. IssueEvent
    let issue = IssueEvent {
        token_id: "c-1".to_string(),
        kind: 0,
        issuer_id: "alice.near".parse().unwrap(),
        owner_id: "alice.near".parse().unwrap(),
        debtor: Some(Debtor::Near("bob.near".parse().unwrap())),
        terms_hash: "a".repeat(64),
        amount_due: U128(1_000_000),
        due_date: 1735689600,
    };
    validate_event_against_schema(
        "issue",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "issue",
            "data": [serde_json::to_value(&issue).unwrap()]
        }),
    );

    // 2. AckEvent
    let ack = AckEvent {
        token_id: "c-1".to_string(),
        scheme: AckScheme::Near {
            account: "bob.near".parse().unwrap(),
        },
        block: 100,
    };
    validate_event_against_schema(
        "ack",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "ack",
            "data": [serde_json::to_value(&ack).unwrap()]
        }),
    );

    // 3. QuoteLoggedEvent
    let quote = QuoteLoggedEvent {
        token_id: "c-1".to_string(),
        quote_id: "q-1".to_string(),
        deposit_address: "0x1234567890abcdef1234567890abcdef12345678".to_string(),
        deadline_requested: 1735693200,
        refund_to: "0xrefund".to_string(),
        route_id: "R1".to_string(),
    };
    validate_event_against_schema(
        "quote_logged",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "quote_logged",
            "data": [serde_json::to_value(&quote).unwrap()]
        }),
    );

    // 4. BookedEvent
    let booked = BookedEvent {
        token_id: "c-1".to_string(),
        payment: U128(1_000_000),
        surplus: U128(0),
        fee: U128(2500),
        credit: U128(0),
        legs: vec![Leg::pay("alice.near".parse().unwrap(), U128(997_500))],
    };
    validate_event_against_schema(
        "booked",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "booked",
            "data": [serde_json::to_value(&booked).unwrap()]
        }),
    );

    // 5. DistributedEvent
    let distributed = DistributedEvent {
        token_id: "c-1".to_string(),
        leg: Leg::pay("alice.near".parse().unwrap(), U128(997_500)),
    };
    validate_event_against_schema(
        "distributed",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "distributed",
            "data": [serde_json::to_value(&distributed).unwrap()]
        }),
    );

    // 6. DistributionFailedEvent
    let failed = DistributionFailedEvent {
        token_id: "c-1".to_string(),
        leg: Leg::pay("alice.near".parse().unwrap(), U128(997_500)),
        reason: Some("gas limit exceeded".to_string()),
    };
    validate_event_against_schema(
        "distribution_failed",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "distribution_failed",
            "data": [serde_json::to_value(&failed).unwrap()]
        }),
    );

    // 7. SurplusEvent
    let surplus = SurplusEvent {
        token_id: "c-1".to_string(),
        amount: U128(50_000),
    };
    validate_event_against_schema(
        "surplus",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "surplus",
            "data": [serde_json::to_value(&surplus).unwrap()]
        }),
    );

    // 8. SurplusReleasedEvent
    let surplus_released = SurplusReleasedEvent {
        token_id: "c-1".to_string(),
        amount: U128(50_000),
        receiver_id: "alice.near".parse().unwrap(),
    };
    validate_event_against_schema(
        "surplus_released",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "surplus_released",
            "data": [serde_json::to_value(&surplus_released).unwrap()]
        }),
    );

    // 9. UnmatchedEvent
    let unmatched = UnmatchedEvent {
        token_id: "c-1".to_string(),
        asset: "unknown.near".parse().unwrap(),
        amount: U128(10_000),
    };
    validate_event_against_schema(
        "unmatched",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "unmatched",
            "data": [serde_json::to_value(&unmatched).unwrap()]
        }),
    );

    // 10. AnomalyEvent
    let anomaly = AnomalyEvent {
        token_id: "c-1".to_string(),
        asset: "usdc.near".parse().unwrap(),
        balance: U128(900_000),
        last_seen: U128(1_000_000),
    };
    validate_event_against_schema(
        "anomaly",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "anomaly",
            "data": [serde_json::to_value(&anomaly).unwrap()]
        }),
    );

    // 11. TransferWindowEvent
    let tw = TransferWindowEvent {
        token_id: "c-1".to_string(),
        until: 1900,
    };
    validate_event_against_schema(
        "transfer_window",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "transfer_window",
            "data": [serde_json::to_value(&tw).unwrap()]
        }),
    );

    // 12. CancelEvent
    let cancel = CancelEvent {
        token_id: "c-1".to_string(),
        reason: Some("debtor request".to_string()),
    };
    validate_event_against_schema(
        "cancel",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "cancel",
            "data": [serde_json::to_value(&cancel).unwrap()]
        }),
    );

    // 13. CloseEvent
    let close = CloseEvent {
        token_id: "c-1".to_string(),
    };
    validate_event_against_schema(
        "close",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "close",
            "data": [serde_json::to_value(&close).unwrap()]
        }),
    );

    // 14. WriteoffEvent
    let writeoff = WriteoffEvent {
        token_id: "c-1".to_string(),
        shortfall: U128(500),
    };
    validate_event_against_schema(
        "writeoff",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "writeoff",
            "data": [serde_json::to_value(&writeoff).unwrap()]
        }),
    );

    // 15. LockClearedEvent
    let lock_cleared = LockClearedEvent {
        token_id: "c-1".to_string(),
        cleared_lock: Lock::Reconciling { since: 50 },
    };
    validate_event_against_schema(
        "lock_cleared",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "lock_cleared",
            "data": [serde_json::to_value(&lock_cleared).unwrap()]
        }),
    );

    // 16. ConfigChangedEvent
    let config_changed = ConfigChangedEvent {
        parameter: "issue_paused".to_string(),
        new_value: "true".to_string(),
    };
    validate_event_against_schema(
        "config_changed",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "config_changed",
            "data": [serde_json::to_value(&config_changed).unwrap()]
        }),
    );

    // 17. ReconcileFailedEvent
    let reconcile_failed = ReconcileFailedEvent {
        token_id: "c-1".to_string(),
        reason: "cross contract call failed".to_string(),
    };
    validate_event_against_schema(
        "reconcile_failed",
        serde_json::json!({
            "standard": OPENRAIL_EVENT_STANDARD,
            "version": OPENRAIL_EVENT_VERSION,
            "event": "reconcile_failed",
            "data": [serde_json::to_value(&reconcile_failed).unwrap()]
        }),
    );

    // 18. NftMintEvent
    let nft_mint = NftMintEvent {
        owner_id: "alice.near".parse().unwrap(),
        token_ids: vec!["c-1".to_string()],
        memo: Some("invoice issued".to_string()),
    };
    validate_event_against_schema(
        "nft_mint",
        serde_json::json!({
            "standard": NEP171_EVENT_STANDARD,
            "version": NEP171_EVENT_VERSION,
            "event": "nft_mint",
            "data": [serde_json::to_value(&nft_mint).unwrap()]
        }),
    );

    // 19. NftTransferEvent
    let nft_transfer = NftTransferEvent {
        authorized_id: None,
        old_owner_id: "alice.near".parse().unwrap(),
        new_owner_id: "bob.near".parse().unwrap(),
        token_ids: vec!["c-1".to_string()],
        memo: Some("sale".to_string()),
    };
    validate_event_against_schema(
        "nft_transfer",
        serde_json::json!({
            "standard": NEP171_EVENT_STANDARD,
            "version": NEP171_EVENT_VERSION,
            "event": "nft_transfer",
            "data": [serde_json::to_value(&nft_transfer).unwrap()]
        }),
    );
}
