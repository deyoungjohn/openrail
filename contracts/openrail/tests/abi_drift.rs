//! Integration test verifying abi/openrail.core.json matches the built contract ABI (Prompt P0.3 item 5).

use near_sdk::serde_json::{self, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

#[test]
fn test_core_abi_format_and_events() {
    let core_abi_path = Path::new("../../abi/openrail.core.json");
    let fallback_path = Path::new("abi/openrail.core.json");
    let path = if core_abi_path.exists() {
        core_abi_path
    } else {
        fallback_path
    };

    let content = fs::read_to_string(path).expect("Failed to read abi/openrail.core.json");
    let core_json: Value =
        serde_json::from_str(&content).expect("Invalid JSON in abi/openrail.core.json");

    assert_eq!(
        core_json.get("interface").and_then(Value::as_str),
        Some("v1"),
        "Interface version must be v1"
    );

    let methods = core_json
        .get("methods")
        .and_then(Value::as_array)
        .expect("methods array missing in abi/openrail.core.json");

    assert!(
        methods.len() >= 35,
        "Expected at least 35 core methods, found {}",
        methods.len()
    );

    for m in methods {
        let obj = m.as_object().expect("method must be object");
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .expect("method name string");
        let kind = obj
            .get("kind")
            .and_then(Value::as_str)
            .expect("method kind string");
        assert!(
            kind == "call" || kind == "view",
            "Method {} has invalid kind {}",
            name,
            kind
        );
    }

    let events = core_json
        .get("events")
        .and_then(Value::as_array)
        .expect("events array missing in abi/openrail.core.json");

    let event_names: BTreeSet<String> = events
        .iter()
        .map(|e| e.as_str().expect("event name must be string").to_string())
        .collect();

    let expected_events = [
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

    for exp in expected_events {
        assert!(
            event_names.contains(exp),
            "Expected event {} missing from abi/openrail.core.json",
            exp
        );
    }
}

#[test]
fn test_built_abi_drift() {
    let built_abi_path = Path::new("../../target/near/openrail/openrail_abi.json");
    let fallback_built_path = Path::new("target/near/openrail/openrail_abi.json");
    let has_near_target = Path::new("../../target/near").exists()
        || Path::new("target/near").exists()
        || std::env::var("REQUIRE_BUILT_ABI").is_ok();

    let built_path = if built_abi_path.exists() {
        built_abi_path
    } else if fallback_built_path.exists() {
        fallback_built_path
    } else if has_near_target && std::env::var("CI").is_ok() {
        panic!(
            "target/near exists, but openrail_abi.json was not found in CI; failing drift check"
        );
    } else {
        println!("openrail_abi.json not built in this environment; skipping drift check");
        return;
    };

    let core_abi_path = Path::new("../../abi/openrail.core.json");
    let fallback_path = Path::new("abi/openrail.core.json");
    let path = if core_abi_path.exists() {
        core_abi_path
    } else {
        fallback_path
    };

    let core_content = fs::read_to_string(path).expect("Failed to read abi/openrail.core.json");
    let core_json: Value = serde_json::from_str(&core_content).expect("Invalid JSON in core ABI");

    let built_content = fs::read_to_string(built_path).expect("Failed to read built ABI");
    let built_json: Value =
        serde_json::from_str(&built_content).expect("Invalid JSON in built ABI");

    let expected_methods: BTreeSet<String> = core_json
        .get("methods")
        .and_then(Value::as_array)
        .expect("methods array missing")
        .iter()
        .map(|m| m.get("name").and_then(Value::as_str).unwrap().to_string())
        .collect();

    let actual_methods: BTreeSet<String> = built_json
        .get("body")
        .and_then(|b| b.get("functions"))
        .and_then(Value::as_array)
        .expect("body.functions missing in built ABI")
        .iter()
        .map(|f| f.get("name").and_then(Value::as_str).unwrap().to_string())
        .collect();

    let missing: Vec<_> = expected_methods.difference(&actual_methods).collect();
    let extra: Vec<_> = actual_methods.difference(&expected_methods).collect();

    assert!(
        missing.is_empty(),
        "Methods declared in abi/openrail.core.json missing from contract: {:?}",
        missing
    );
    assert!(
        extra.is_empty(),
        "Extra methods in contract not declared in abi/openrail.core.json: {:?}",
        extra
    );
}
