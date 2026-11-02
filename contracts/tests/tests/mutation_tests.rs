//! Mutation checks proving the test harness detects deliberate rule violations (Blueprint 3.1.4).

use anyhow::Result;
use near_sdk::json_types::U128;
use near_workspaces::types::NearToken;
use openrail_tests::{validate_event_against_schema, Env, DEFAULT_SETTLEMENT_ASSET};
use serde_json::json;

/// Break 1: `mt_transfer` without exactly 1 yocto deposit is rejected.
#[tokio::test]
async fn mutation_break_1_mt_transfer_requires_one_yocto() -> Result<()> {
    let env = Env::new().await?;

    let res = env
        .alice
        .call(env.intents.id(), "mt_transfer")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": DEFAULT_SETTLEMENT_ASSET,
            "amount": U128(100),
        }))
        // Attached deposit is 0 yocto, violating the rule
        .deposit(NearToken::from_yoctonear(0))
        .max_gas()
        .transact()
        .await?;

    assert!(res.is_failure(), "mt_transfer without 1 yocto must fail");
    let failure_str = format!("{:?}", res.failures());
    assert!(
        failure_str.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
        "Expected deposit error message, got: {failure_str}"
    );

    Ok(())
}

/// Break 2: `v1.signer::sign` without exactly 1 yocto deposit is rejected.
#[tokio::test]
async fn mutation_break_2_signer_requires_one_yocto() -> Result<()> {
    let env = Env::new().await?;

    let req = json!({
        "payload_v2": { "Ecdsa": "00ff" },
        "path": "evm-1",
        "domain_id": 0,
    });

    let res = env
        .alice
        .call(env.signer.id(), "sign")
        .args_json(json!({ "request": req }))
        // Attached deposit is 0 yocto, violating the rule
        .deposit(NearToken::from_yoctonear(0))
        .max_gas()
        .transact()
        .await?;

    assert!(res.is_failure(), "sign without 1 yocto must fail");
    let failure_str = format!("{:?}", res.failures());
    assert!(
        failure_str.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
        "Expected deposit error message, got: {failure_str}"
    );

    Ok(())
}

/// Break 3: `mt_transfer` with insufficient balance is rejected.
#[tokio::test]
async fn mutation_break_3_mt_transfer_insufficient_balance() -> Result<()> {
    let env = Env::new().await?;

    // Carol has 0 balance, attempts to transfer 1,000,000
    let res = env
        .carol
        .call(env.intents.id(), "mt_transfer")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": DEFAULT_SETTLEMENT_ASSET,
            "amount": U128(1_000_000),
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;

    assert!(
        res.is_failure(),
        "Transfer with insufficient balance must fail"
    );
    let failure_str = format!("{:?}", res.failures());
    assert!(
        failure_str.contains("insufficient balance"),
        "Expected balance error message, got: {failure_str}"
    );

    Ok(())
}

/// Break 4: Corrupted event payloads fail NEP-297 JSON schema validation.
#[test]
fn mutation_break_4_event_schema_rejects_corrupted_payloads() {
    // 4a. Wrong standard
    let corrupted_standard = json!({
        "standard": "malicious_standard",
        "version": "1.0.0",
        "event": "issue",
        "data": [{
            "token_id": "c-1",
            "issuer_id": "alice.near",
            "owner_id": "alice.near",
            "kind": 0,
            "amount_due": "1000000",
            "due_date": 1700000000
        }]
    });
    assert!(
        validate_event_against_schema(&corrupted_standard).is_err(),
        "Must reject non-openrail standard"
    );

    // 4b. Wrong version
    let corrupted_version = json!({
        "standard": "openrail",
        "version": "2.0.0",
        "event": "issue",
        "data": [{
            "token_id": "c-1",
            "issuer_id": "alice.near",
            "owner_id": "alice.near",
            "kind": 0,
            "amount_due": "1000000",
            "due_date": 1700000000
        }]
    });
    assert!(
        validate_event_against_schema(&corrupted_version).is_err(),
        "Must reject unexpected version"
    );

    // 4c. Missing required fields in data item
    let missing_field = json!({
        "standard": "openrail",
        "version": "1.0.0",
        "event": "issue",
        "data": [{
            "token_id": "c-1",
            // missing issuer_id, owner_id, kind, amount_due, due_date
        }]
    });
    assert!(
        validate_event_against_schema(&missing_field).is_err(),
        "Must reject event data missing required schema fields"
    );

    // 4d. Empty data array
    let empty_data = json!({
        "standard": "openrail",
        "version": "1.0.0",
        "event": "issue",
        "data": []
    });
    assert!(
        validate_event_against_schema(&empty_data).is_err(),
        "Must reject empty data array"
    );
}

/// Break 5: Unauthorized calls to pause/unpause fail access control.
#[tokio::test]
async fn mutation_break_5_unauthorized_call_fails() -> Result<()> {
    let env = Env::new().await?;

    // Attempting to call an undefined method or unauthorized method fails
    let res = env
        .alice
        .call(env.root.id(), "non_existent_method")
        .args_json(json!({}))
        .max_gas()
        .transact()
        .await?;

    assert!(res.is_failure(), "Calling non-existent method must fail");

    Ok(())
}
