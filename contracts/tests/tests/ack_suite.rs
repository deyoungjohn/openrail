//! Ack Test Suite (Blueprint 2.7 & 2.11: 10 named Ack tests).
//!
//! Independent specification-driven tests verifying EIP-712 typed data hashing,
//! signature verification with malleability prevention, replay protection across claims and
//! deployments, write-once enforcement, and parity against the viem reference vectors.
//!
//! Vectors:
//!   - `fixtures/vectors/ack-v1.json`: generated independently by viem 2.57.14 for Openrail.
//!   - `fixtures/vectors/K14-vectors.json`: vectors from the K14 test run.
//!
//! Method calls pending C3 implementation are marked with `#[ignore = "C3"]`.

use anyhow::Result;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use openrail::eip712::{
    ack_digest, cancel_digest, recover_address, verify_ack, verify_cancel, AckError, EnvEcrecover,
    K14_ACK, OPENRAIL_ACK,
};
use openrail::types::{ClaimView, Debtor, Hex20, Hex32, HexBytes};
use openrail_model::{
    AckScheme as ModelAckScheme, Action, Debtor as ModelDebtor, Hex20 as ModelHex20,
    Hex32 as ModelHex32, Model, ModelError,
};
use openrail_tests::Env;
use serde::Deserialize;
use serde_json::json;

// ──────────────────────────────────────────────
// Fixture Data Structures
// ──────────────────────────────────────────────

const ACK_V1_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/vectors/ack-v1.json"
));

const K14_VECTORS_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/vectors/K14-vectors.json"
));

#[derive(Deserialize)]
#[allow(dead_code)]
struct AckV1Fixture {
    signer: String,
    ack: Vec<AckVector>,
    cancel: Vec<CancelVector>,
    tamper_ack: Vec<TamperAckVector>,
    tamper_cancel: Vec<TamperCancelVector>,
}

#[derive(Deserialize, Clone)]
#[allow(dead_code)]
struct AckVector {
    name: String,
    chain_id: u64,
    root_contract: String,
    token_id: String,
    terms_hash: String,
    amount_due: String,
    due_date: u64,
    digest: String,
    signer: String,
    signature: String,
}

#[derive(Deserialize, Clone)]
#[allow(dead_code)]
struct CancelVector {
    name: String,
    chain_id: u64,
    root_contract: String,
    token_id: String,
    digest: String,
    signer: String,
    signature: String,
}

#[derive(Deserialize, Clone)]
#[allow(dead_code)]
struct TamperAckVector {
    name: String,
    chain_id: u64,
    root_contract: String,
    token_id: String,
    terms_hash: String,
    amount_due: String,
    due_date: u64,
    digest: String,
    signature: String,
    base: String,
    tamper_kind: String,
}

#[derive(Deserialize, Clone)]
#[allow(dead_code)]
struct TamperCancelVector {
    name: String,
    chain_id: u64,
    root_contract: String,
    token_id: String,
    digest: String,
    signature: String,
    base: String,
    tamper_kind: String,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct K14Fixture {
    owed_contract: String,
    other_deployment: K14OtherDeployment,
    valid: Vec<K14Vector>,
    wrong_signer_sig: String,
    sig_signed_for_other_contract: String,
    high_s_sig: String,
    safe_contract_wallet_blob: String,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct K14OtherDeployment {
    owed_contract: String,
    ack_sig: String,
}

#[derive(Deserialize, Clone)]
#[allow(dead_code)]
struct K14Vector {
    token_id: String,
    debtor_evm: String,
    terms_hash: String,
    amount_due: String,
    due_date: u64,
    chain_id: u64,
    digest: String,
    sig: String,
    sig_v01: String,
}

fn load_ack_v1() -> AckV1Fixture {
    serde_json::from_str(ACK_V1_JSON).expect("ack-v1.json fixture parses")
}

fn load_k14() -> K14Fixture {
    serde_json::from_str(K14_VECTORS_JSON).expect("K14-vectors.json fixture parses")
}

fn setup_vm() {
    testing_env!(VMContextBuilder::new().build());
}

fn hex32(s: &str) -> [u8; 32] {
    Hex32::from_hex(s).expect("valid 32-byte hex").0
}

fn hex20(s: &str) -> [u8; 20] {
    Hex20::from_hex(s).expect("valid 20-byte hex").0
}

fn hex_bytes(s: &str) -> Vec<u8> {
    HexBytes::from_hex(s).expect("valid hex bytes").0
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

// ──────────────────────────────────────────────
// 1. ack_eip712_valid
// ──────────────────────────────────────────────

#[test]
fn ack_eip712_valid() {
    setup_vm();
    let ack_fixture = load_ack_v1();
    let expected_signer = hex20(&ack_fixture.signer);

    // 1. Verify all 12 Openrail ack vectors across 6 EVM chain IDs
    for v in &ack_fixture.ack {
        let terms = hex32(&v.terms_hash);
        let amount = v.amount_due.parse::<u128>().expect("amount parses");
        let sig = hex_bytes(&v.signature);

        let recovered = verify_ack(
            &EnvEcrecover,
            OPENRAIL_ACK,
            v.chain_id,
            &v.root_contract,
            &v.token_id,
            &terms,
            amount,
            v.due_date,
            &expected_signer,
            &sig,
        )
        .unwrap_or_else(|e| panic!("ack vector {} failed verify_ack: {e:?}", v.name));

        assert_eq!(recovered, expected_signer, "vector {}", v.name);
    }

    // 2. Verify all 6 Openrail cancel vectors
    for c in &ack_fixture.cancel {
        let sig = hex_bytes(&c.signature);
        let recovered = verify_cancel(
            &EnvEcrecover,
            c.chain_id,
            &c.root_contract,
            &c.token_id,
            &expected_signer,
            &sig,
        )
        .unwrap_or_else(|e| panic!("cancel vector {} failed verify_cancel: {e:?}", c.name));

        assert_eq!(recovered, expected_signer, "vector {}", c.name);
    }

    // 3. Verify against openrail-model oracle state machine
    let mut model = Model::new();
    let terms_hash = ModelHex32(hex32(&ack_fixture.ack[0].terms_hash));
    let model_debtor = ModelHex20(expected_signer);
    model
        .step(
            Action::Issue {
                token_id: "c-1".to_string(),
                issuer_id: "alice.near".to_string(),
                debtor: Some(ModelDebtor::Evm(model_debtor)),
                terms_hash,
                amount_due: 1_000_137,
                due_date: 1800086400,
                kind: 0,
            },
            1,
        )
        .expect("issue in model succeeds");

    let events = model
        .step(
            Action::AcknowledgeEvm {
                token_id: "c-1".to_string(),
                chain_id: 1,
                signer: model_debtor,
            },
            2,
        )
        .expect("ack evm in model succeeds");

    assert_eq!(events.len(), 1);
    assert!(
        matches!(&events[0], openrail_model::Event::Ack { token_id, scheme } if token_id == "c-1" && matches!(scheme, ModelAckScheme::Evm { chain_id: 1, signer } if *signer == model_debtor))
    );
    let claim = model.claims.get("c-1").unwrap();
    assert!(claim.ack.is_some());
}

#[tokio::test]
async fn contract_ack_eip712_valid() -> Result<()> {
    let env = Env::new().await?;
    let ack_fixture = load_ack_v1();
    let v = &ack_fixture.ack[0];

    // Issue claim with EVM debtor
    let issue_res = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Evm(
                Hex20::from_hex(&v.signer).map_err(|e| anyhow::anyhow!("{e}"))?,
            )),
            Hex32::from_hex(&v.terms_hash).map_err(|e| anyhow::anyhow!("{e}"))?,
            v.amount_due.parse::<u128>()?,
            v.due_date,
            None,
        )
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    // Relayed acknowledge_evm transaction succeeds
    let ack_res = env
        .bob
        .call(env.root.id(), "acknowledge_evm")
        .args_json(json!({
            "token_id": token_id,
            "chain_id": v.chain_id,
            "sig": v.signature,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack_res.is_success());

    // Claim view reflects ack
    let claim: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    assert!(claim.and_then(|c| c.ack).is_some());

    Ok(())
}

// ──────────────────────────────────────────────
// 2. ack_eip712_tamper
// ──────────────────────────────────────────────

#[test]
fn ack_eip712_tamper() {
    setup_vm();
    let ack_fixture = load_ack_v1();
    let expected_signer = hex20(&ack_fixture.signer);

    // Map base names to their authentic signatures
    let base_ack_sigs: std::collections::BTreeMap<String, Vec<u8>> = ack_fixture
        .ack
        .iter()
        .map(|a| (a.name.clone(), hex_bytes(&a.signature)))
        .collect();

    // Verify each tampered ack vector
    for t in &ack_fixture.tamper_ack {
        let base_sig = base_ack_sigs
            .get(&t.base)
            .unwrap_or_else(|| panic!("missing base {}", t.base));

        let terms = hex32(&t.terms_hash);
        let amount = t.amount_due.parse::<u128>().expect("amount parses");

        // Verifying the original signature against tampered payload must fail or recover wrong signer
        let result = verify_ack(
            &EnvEcrecover,
            OPENRAIL_ACK,
            t.chain_id,
            &t.root_contract,
            &t.token_id,
            &terms,
            amount,
            t.due_date,
            &expected_signer,
            base_sig,
        );

        match result {
            Err(AckError::WrongSigner) | Err(AckError::BadSignature) => {}
            Ok(recovered) => {
                assert_ne!(
                    recovered, expected_signer,
                    "tamper {} ({}) should not recover original signer",
                    t.name, t.tamper_kind
                );
            }
            Err(e) => panic!("unexpected error on tamper {}: {e:?}", t.name),
        }
    }

    // Verify tampered cancel vector
    let base_cancel_sigs: std::collections::BTreeMap<String, Vec<u8>> = ack_fixture
        .cancel
        .iter()
        .map(|c| (c.name.clone(), hex_bytes(&c.signature)))
        .collect();

    for tc in &ack_fixture.tamper_cancel {
        let base_sig = base_cancel_sigs
            .get(&tc.base)
            .unwrap_or_else(|| panic!("missing base {}", tc.base));

        let result = verify_cancel(
            &EnvEcrecover,
            tc.chain_id,
            &tc.root_contract,
            &tc.token_id,
            &expected_signer,
            base_sig,
        );

        match result {
            Err(AckError::WrongSigner) | Err(AckError::BadSignature) => {}
            Ok(recovered) => {
                assert_ne!(
                    recovered, expected_signer,
                    "tamper cancel {} should not recover original signer",
                    tc.name
                );
            }
            Err(e) => panic!("unexpected error on tamper cancel {}: {e:?}", tc.name),
        }
    }
}

#[tokio::test]
async fn contract_ack_eip712_tamper() -> Result<()> {
    let env = Env::new().await?;
    let ack_fixture = load_ack_v1();
    let v = &ack_fixture.ack[0];

    let issue_res = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Evm(
                Hex20::from_hex(&v.signer).map_err(|e| anyhow::anyhow!("{e}"))?,
            )),
            Hex32::from_hex(&v.terms_hash).map_err(|e| anyhow::anyhow!("{e}"))?,
            v.amount_due.parse::<u128>()?,
            v.due_date,
            None,
        )
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    // Tampered chain_id fails on contract
    let ack_res = env
        .bob
        .call(env.root.id(), "acknowledge_evm")
        .args_json(json!({
            "token_id": token_id,
            "chain_id": 8453, // tampered chain ID
            "sig": v.signature,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack_res.is_failure());

    Ok(())
}

// ──────────────────────────────────────────────
// 3. ack_wrong_signer
// ──────────────────────────────────────────────

#[test]
fn ack_wrong_signer() {
    setup_vm();
    let k14 = load_k14();
    let v = &k14.valid[0];
    let terms = hex32(&v.terms_hash);
    let amount = v.amount_due.parse::<u128>().expect("amount parses");
    let wrong_sig = hex_bytes(&k14.wrong_signer_sig);
    let expected_debtor = hex20(&v.debtor_evm);

    // Signature signed by an unauthorized key for this claim returns WrongSigner
    let err = verify_ack(
        &EnvEcrecover,
        K14_ACK,
        v.chain_id,
        &k14.owed_contract,
        &v.token_id,
        &terms,
        amount,
        v.due_date,
        &expected_debtor,
        &wrong_sig,
    )
    .expect_err("wrong signer signature must fail");

    assert_eq!(err, AckError::WrongSigner);
}

#[tokio::test]
async fn contract_ack_wrong_signer() -> Result<()> {
    let env = Env::new().await?;
    let k14 = load_k14();
    let v = &k14.valid[0];

    let issue_res = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Evm(
                Hex20::from_hex(&v.debtor_evm).map_err(|e| anyhow::anyhow!("{e}"))?,
            )),
            Hex32::from_hex(&v.terms_hash).map_err(|e| anyhow::anyhow!("{e}"))?,
            v.amount_due.parse::<u128>()?,
            v.due_date,
            None,
        )
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    let ack_res = env
        .bob
        .call(env.root.id(), "acknowledge_evm")
        .args_json(json!({
            "token_id": token_id,
            "chain_id": v.chain_id,
            "sig": k14.wrong_signer_sig,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack_res.is_failure());

    Ok(())
}

// ──────────────────────────────────────────────
// 4. ack_v_normalised
// ──────────────────────────────────────────────

#[test]
fn ack_v_normalised() {
    setup_vm();
    let k14 = load_k14();

    // Verify all 20 K14 vectors support both v conventions (27/28 and 0/1)
    for v in &k14.valid {
        let terms = hex32(&v.terms_hash);
        let amount = v.amount_due.parse::<u128>().expect("amount parses");
        let debtor = hex20(&v.debtor_evm);

        let sig_27 = hex_bytes(&v.sig);
        let sig_01 = hex_bytes(&v.sig_v01);

        let recovered_27 = verify_ack(
            &EnvEcrecover,
            K14_ACK,
            v.chain_id,
            &k14.owed_contract,
            &v.token_id,
            &terms,
            amount,
            v.due_date,
            &debtor,
            &sig_27,
        )
        .expect("v=27/28 succeeds");

        let recovered_01 = verify_ack(
            &EnvEcrecover,
            K14_ACK,
            v.chain_id,
            &k14.owed_contract,
            &v.token_id,
            &terms,
            amount,
            v.due_date,
            &debtor,
            &sig_01,
        )
        .expect("v=0/1 succeeds");

        assert_eq!(recovered_27, recovered_01);
        assert_eq!(recovered_27, debtor);
    }

    // Invalid v values (e.g. 2, 3, 29, 37, 255) must be rejected with BadV
    let v = &k14.valid[0];
    let digest = hex32(&v.digest);
    let mut sig_invalid_v = hex_bytes(&v.sig);

    for bad_v in [2u8, 3, 4, 26, 29, 37, 38, 255] {
        sig_invalid_v[64] = bad_v;
        let err = recover_address(&EnvEcrecover, &digest, &sig_invalid_v)
            .expect_err(&format!("bad v {bad_v} should fail"));
        assert_eq!(err, AckError::BadV, "v = {bad_v}");
    }
}

#[tokio::test]
async fn contract_ack_v_normalised() -> Result<()> {
    let env = Env::new().await?;
    let fixture = load_ack_v1();
    let v = &fixture.ack[0];
    let sig = &v.signature;
    let v_byte = u8::from_str_radix(&sig[sig.len() - 2..], 16)?;
    let normalized = if v_byte >= 27 { v_byte - 27 } else { v_byte };
    let sig_v01 = format!("{}{:02x}", &sig[..sig.len() - 2], normalized);

    let issue_res = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Evm(
                Hex20::from_hex(&v.signer).map_err(|e| anyhow::anyhow!("{e}"))?,
            )),
            Hex32::from_hex(&v.terms_hash).map_err(|e| anyhow::anyhow!("{e}"))?,
            v.amount_due.parse::<u128>()?,
            v.due_date,
            None,
        )
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    // v = 0/1 works on contract
    let ack_res = env
        .bob
        .call(env.root.id(), "acknowledge_evm")
        .args_json(json!({
            "token_id": token_id,
            "chain_id": v.chain_id,
            "sig": sig_v01,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack_res.is_success());

    Ok(())
}

// ──────────────────────────────────────────────
// 5. ack_high_s_rejected
// ──────────────────────────────────────────────

#[test]
fn ack_high_s_rejected() {
    setup_vm();
    let k14 = load_k14();
    let v = &k14.valid[0];
    let high_s = hex_bytes(&k14.high_s_sig);
    let amount = v.amount_due.parse::<u128>().expect("amount parses");

    // Malleability flag ensures high-s is rejected through verify_ack with real EnvEcrecover
    let err = verify_ack(
        &EnvEcrecover,
        K14_ACK,
        v.chain_id,
        &k14.owed_contract,
        &v.token_id,
        &hex32(&v.terms_hash),
        amount,
        v.due_date,
        &hex20(&v.debtor_evm),
        &high_s,
    )
    .expect_err("high-s signature must be rejected");
    assert_eq!(err, AckError::BadSignature);
}

#[tokio::test]
async fn contract_ack_high_s_rejected() -> Result<()> {
    let env = Env::new().await?;
    let k14 = load_k14();
    let v = &k14.valid[0];

    let issue_res = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Evm(
                Hex20::from_hex(&v.debtor_evm).map_err(|e| anyhow::anyhow!("{e}"))?,
            )),
            Hex32::from_hex(&v.terms_hash).map_err(|e| anyhow::anyhow!("{e}"))?,
            v.amount_due.parse::<u128>()?,
            v.due_date,
            None,
        )
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    // Contract rejects high-s signature
    let ack_res = env
        .bob
        .call(env.root.id(), "acknowledge_evm")
        .args_json(json!({
            "token_id": token_id,
            "chain_id": v.chain_id,
            "sig": k14.high_s_sig,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack_res.is_failure());

    Ok(())
}

// ──────────────────────────────────────────────
// 6. ack_replay_other_invoice
// ──────────────────────────────────────────────

#[test]
fn ack_replay_other_invoice() {
    setup_vm();
    let k14 = load_k14();
    let v1 = &k14.valid[0]; // inv-1
    let v2 = &k14.valid[1]; // inv-2

    let terms2 = hex32(&v2.terms_hash);
    let amount2 = v2.amount_due.parse::<u128>().expect("amount parses");
    let debtor2 = hex20(&v2.debtor_evm);
    let sig1 = hex_bytes(&v1.sig);

    // Attempting to use inv-1's signature on inv-2 must fail
    let err = verify_ack(
        &EnvEcrecover,
        K14_ACK,
        v2.chain_id,
        &k14.owed_contract,
        &v2.token_id,
        &terms2,
        amount2,
        v2.due_date,
        &debtor2,
        &sig1,
    )
    .expect_err("cross-invoice replay must fail");

    assert!(matches!(
        err,
        AckError::WrongSigner | AckError::BadSignature
    ));
}

#[tokio::test]
async fn contract_ack_replay_other_invoice() -> Result<()> {
    let env = Env::new().await?;
    let ack_fixture = load_ack_v1();
    let v1 = &ack_fixture.ack[0]; // c-1
    let v2 = &ack_fixture.ack[1]; // c-2

    // Issue claim 2
    let issue_res = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Evm(
                Hex20::from_hex(&v2.signer).map_err(|e| anyhow::anyhow!("{e}"))?,
            )),
            Hex32::from_hex(&v2.terms_hash).map_err(|e| anyhow::anyhow!("{e}"))?,
            v2.amount_due.parse::<u128>()?,
            v2.due_date,
            None,
        )
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    // Attempt to submit c-1's signature on c-2 fails
    let ack_res = env
        .bob
        .call(env.root.id(), "acknowledge_evm")
        .args_json(json!({
            "token_id": token_id,
            "chain_id": v2.chain_id,
            "sig": v1.signature,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack_res.is_failure());

    Ok(())
}

// ──────────────────────────────────────────────
// 7. ack_replay_other_deployment
// ──────────────────────────────────────────────

#[test]
fn ack_replay_other_deployment() {
    setup_vm();
    let k14 = load_k14();
    let other_deployment_sig = hex_bytes(&k14.other_deployment.ack_sig);
    let debtor = hex20(&k14.valid[0].debtor_evm);
    let terms = hex32(&k14.valid[0].terms_hash);
    let amount = k14.valid[0].amount_due.parse::<u128>().unwrap();

    // Verifying a signature from other deployment against this contract must fail
    let err = verify_ack(
        &EnvEcrecover,
        K14_ACK,
        k14.valid[0].chain_id,
        &k14.owed_contract, // "owedk14.test.near" != "owedother.test.near"
        &k14.valid[0].token_id,
        &terms,
        amount,
        k14.valid[0].due_date,
        &debtor,
        &other_deployment_sig,
    )
    .expect_err("cross-deployment replay must fail");

    assert!(matches!(
        err,
        AckError::WrongSigner | AckError::BadSignature
    ));
}

#[tokio::test]
async fn contract_ack_replay_other_deployment() -> Result<()> {
    let env = Env::new().await?;
    let k14 = load_k14();
    let v = &k14.valid[0];

    let issue_res = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Evm(
                Hex20::from_hex(&v.debtor_evm).map_err(|e| anyhow::anyhow!("{e}"))?,
            )),
            Hex32::from_hex(&v.terms_hash).map_err(|e| anyhow::anyhow!("{e}"))?,
            v.amount_due.parse::<u128>()?,
            v.due_date,
            None,
        )
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    let ack_res = env
        .bob
        .call(env.root.id(), "acknowledge_evm")
        .args_json(json!({
            "token_id": token_id,
            "chain_id": v.chain_id,
            "sig": k14.other_deployment.ack_sig,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack_res.is_failure());

    Ok(())
}

// ──────────────────────────────────────────────
// 8. ack_only_once
// ──────────────────────────────────────────────

#[test]
fn ack_only_once() {
    setup_vm();
    let ack_fixture = load_ack_v1();
    let v = &ack_fixture.ack[0];
    let sig = hex_bytes(&v.signature);
    let expected_signer = hex20(&v.signer);
    let amount = v.amount_due.parse::<u128>().expect("amount parses");

    // Drive verify_ack with real EnvEcrecover on the vector before proving write-once semantics
    let recovered = verify_ack(
        &EnvEcrecover,
        OPENRAIL_ACK,
        v.chain_id,
        &v.root_contract,
        &v.token_id,
        &hex32(&v.terms_hash),
        amount,
        v.due_date,
        &expected_signer,
        &sig,
    )
    .expect("verify_ack with EnvEcrecover succeeds on valid vector");
    assert_eq!(recovered, expected_signer);

    // Model oracle verification of write-once ack
    let mut model = Model::new();
    let debtor = ModelHex20([0x11; 20]);
    model
        .step(
            Action::Issue {
                token_id: "c-1".to_string(),
                issuer_id: "alice.near".to_string(),
                debtor: Some(ModelDebtor::Evm(debtor)),
                terms_hash: ModelHex32([0x22; 32]),
                amount_due: 1000,
                due_date: 2000,
                kind: 0,
            },
            1,
        )
        .expect("issue succeeds");

    // First ack succeeds
    model
        .step(
            Action::AcknowledgeEvm {
                token_id: "c-1".to_string(),
                chain_id: 1,
                signer: debtor,
            },
            2,
        )
        .expect("first ack succeeds");

    // Second EVM ack fails with AlreadyAcknowledged
    let err = model
        .step(
            Action::AcknowledgeEvm {
                token_id: "c-1".to_string(),
                chain_id: 1,
                signer: debtor,
            },
            3,
        )
        .unwrap_err();
    assert_eq!(err, ModelError::AlreadyAcknowledged);

    // Second NEAR ack also fails with AlreadyAcknowledged
    let err_near = model
        .step(
            Action::AcknowledgeNear {
                token_id: "c-1".to_string(),
                caller: "bob.near".to_string(),
            },
            4,
        )
        .unwrap_err();
    assert_eq!(err_near, ModelError::AlreadyAcknowledged);
}

#[tokio::test]
async fn contract_ack_only_once() -> Result<()> {
    let env = Env::new().await?;
    let ack_fixture = load_ack_v1();
    let v = &ack_fixture.ack[0];

    let issue_res = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Evm(
                Hex20::from_hex(&v.signer).map_err(|e| anyhow::anyhow!("{e}"))?,
            )),
            Hex32::from_hex(&v.terms_hash).map_err(|e| anyhow::anyhow!("{e}"))?,
            v.amount_due.parse::<u128>()?,
            v.due_date,
            None,
        )
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    // First call succeeds
    let ack1 = env
        .bob
        .call(env.root.id(), "acknowledge_evm")
        .args_json(json!({
            "token_id": token_id,
            "chain_id": v.chain_id,
            "sig": v.signature,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack1.is_success());

    // Second call fails
    let ack2 = env
        .bob
        .call(env.root.id(), "acknowledge_evm")
        .args_json(json!({
            "token_id": token_id,
            "chain_id": v.chain_id,
            "sig": v.signature,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack2.is_failure());

    Ok(())
}

// ──────────────────────────────────────────────
// 9. ack_digest_parity (Rust = viem)
// ──────────────────────────────────────────────

#[test]
fn ack_digest_parity() {
    let ack_fixture = load_ack_v1();

    // 1. All 12 Openrail ack vectors match viem digest byte-for-byte
    for v in &ack_fixture.ack {
        let terms = hex32(&v.terms_hash);
        let amount = v.amount_due.parse::<u128>().expect("amount parses");

        let computed = ack_digest(
            OPENRAIL_ACK,
            v.chain_id,
            &v.root_contract,
            &v.token_id,
            &terms,
            amount,
            v.due_date,
        );

        assert_eq!(
            to_hex(&computed).to_lowercase(),
            v.digest.to_lowercase(),
            "ack digest mismatch on {}",
            v.name
        );
    }

    // 2. All 6 Openrail cancel vectors match viem digest byte-for-byte
    for c in &ack_fixture.cancel {
        let computed = cancel_digest(c.chain_id, &c.root_contract, &c.token_id);
        assert_eq!(
            to_hex(&computed).to_lowercase(),
            c.digest.to_lowercase(),
            "cancel digest mismatch on {}",
            c.name
        );
    }

    // 3. All 20 K14 vectors match viem digest byte-for-byte
    let k14 = load_k14();
    for v in &k14.valid {
        let terms = hex32(&v.terms_hash);
        let amount = v.amount_due.parse::<u128>().expect("amount parses");

        let computed = ack_digest(
            K14_ACK,
            v.chain_id,
            &k14.owed_contract,
            &v.token_id,
            &terms,
            amount,
            v.due_date,
        );

        assert_eq!(
            to_hex(&computed).to_lowercase(),
            v.digest.to_lowercase(),
            "K14 digest mismatch on {}",
            v.token_id
        );
    }

    // 4. Drive verify_ack with real EnvEcrecover on vector 0 to prove the recover path
    setup_vm();
    let v0 = &ack_fixture.ack[0];
    let amount0 = v0.amount_due.parse::<u128>().expect("amount parses");
    let recovered0 = verify_ack(
        &EnvEcrecover,
        OPENRAIL_ACK,
        v0.chain_id,
        &v0.root_contract,
        &v0.token_id,
        &hex32(&v0.terms_hash),
        amount0,
        v0.due_date,
        &hex20(&v0.signer),
        &hex_bytes(&v0.signature),
    )
    .expect("verify_ack recovers expected signer on vector 0");
    assert_eq!(recovered0, hex20(&v0.signer));
}

// ──────────────────────────────────────────────
// 10. ack_contract_wallet_refused
// ──────────────────────────────────────────────

#[test]
fn ack_contract_wallet_refused() {
    setup_vm();
    let k14 = load_k14();
    let v = &k14.valid[0];
    let contract_wallet_blob = hex_bytes(&k14.safe_contract_wallet_blob);
    let amount = v.amount_due.parse::<u128>().expect("amount parses");

    // EIP-1271 contract wallet signature is refused before recovery through verify_ack with EnvEcrecover
    let err = verify_ack(
        &EnvEcrecover,
        K14_ACK,
        v.chain_id,
        &k14.owed_contract,
        &v.token_id,
        &hex32(&v.terms_hash),
        amount,
        v.due_date,
        &hex20(&v.debtor_evm),
        &contract_wallet_blob,
    )
    .expect_err("contract wallet signature must be refused");
    assert_eq!(err, AckError::ContractWallet);
}

#[tokio::test]
async fn contract_ack_contract_wallet_refused() -> Result<()> {
    let env = Env::new().await?;
    let k14 = load_k14();
    let v = &k14.valid[0];

    let issue_res = env
        .issue_claim_with_details(
            &env.alice,
            0,
            Some(Debtor::Evm(
                Hex20::from_hex(&v.debtor_evm).map_err(|e| anyhow::anyhow!("{e}"))?,
            )),
            Hex32::from_hex(&v.terms_hash).map_err(|e| anyhow::anyhow!("{e}"))?,
            v.amount_due.parse::<u128>()?,
            v.due_date,
            None,
        )
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    let ack_res = env
        .bob
        .call(env.root.id(), "acknowledge_evm")
        .args_json(json!({
            "token_id": token_id,
            "chain_id": v.chain_id,
            "sig": k14.safe_contract_wallet_blob,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(ack_res.is_failure());

    Ok(())
}
