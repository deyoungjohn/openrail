//! EIP-712 acknowledgement and cancel digests (Blueprint 2.7).
//!
//! The 20 K14 vectors (plus the tamper/wrong-signer/replay fixtures) use the earlier `Owed`
//! domain; they are the viem parity oracle for the algorithm. Production constants
//! (`OPENRAIL_ACK`, `cancel_digest`) are checked against a viem-generated Openrail vector at
//! the bottom of this file.

use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use openrail::eip712::{
    ack_digest, cancel_digest, recover_address, verify_ack, verify_cancel, AckError, Ecrecover,
    K14_ACK, OPENRAIL_ACK,
};
use openrail::types::{Hex20, Hex32, HexBytes};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

const K14: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/vectors/K14-vectors.json"
));

const ACK_V1: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/vectors/ack-v1.json"
));

#[derive(Deserialize)]
struct K14Fixture {
    owed_contract: String,
    other_deployment: OtherDeployment,
    valid: Vec<Vector>,
    wrong_signer_sig: String,
    sig_signed_for_other_contract: String,
    high_s_sig: String,
    safe_contract_wallet_blob: String,
}

#[derive(Deserialize)]
struct OtherDeployment {
    owed_contract: String,
    ack_sig: String,
}

#[derive(Deserialize)]
struct Vector {
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

fn k14() -> K14Fixture {
    near_sdk::serde_json::from_str(K14).expect("K14-vectors.json parses")
}

fn setup() {
    testing_env!(VMContextBuilder::new().build());
}

fn bytes32(value: &str) -> [u8; 32] {
    Hex32::from_hex(value).expect("32-byte hex").0
}

fn address(value: &str) -> [u8; 20] {
    Hex20::from_hex(value).expect("20-byte hex").0
}

fn signature(value: &str) -> Vec<u8> {
    HexBytes::from_hex(value).expect("signature hex").0
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn amount(vector: &Vector) -> u128 {
    vector.amount_due.parse().expect("amount is u128")
}

/// Pure-Rust ECDSA recovery for the host vectors (production uses `EnvEcrecover`).
struct K256Recover;

impl Ecrecover for K256Recover {
    fn ecrecover(
        &self,
        digest: &[u8; 32],
        signature: &[u8; 64],
        recovery_id: u8,
        malleability_flag: bool,
    ) -> Option<[u8; 64]> {
        let signature = k256::ecdsa::Signature::from_slice(signature).ok()?;
        // Mirror env::ecrecover: with the malleability flag on, the high-s twin is refused;
        // with it off, accept it (normalised) so the flag itself is observable.
        let signature = if malleability_flag {
            if signature.normalize_s().is_some() {
                return None;
            }
            signature
        } else {
            signature.normalize_s().unwrap_or(signature)
        };
        let recovery_id = k256::ecdsa::RecoveryId::from_byte(recovery_id)?;
        let key = k256::ecdsa::VerifyingKey::recover_from_prehash(digest, &signature, recovery_id)
            .ok()?;
        key.to_encoded_point(false)
            .as_bytes()
            .get(1..65)?
            .try_into()
            .ok()
    }
}

fn k14_digest(fixture: &K14Fixture, vector: &Vector) -> [u8; 32] {
    ack_digest(
        K14_ACK,
        vector.chain_id,
        &fixture.owed_contract,
        &vector.token_id,
        &bytes32(&vector.terms_hash),
        amount(vector),
        vector.due_date,
    )
}

#[test]
fn ack_digest_parity() {
    setup();
    let fixture = k14();
    for vector in &fixture.valid {
        assert_eq!(
            hex(&k14_digest(&fixture, vector)),
            vector.digest,
            "{}: Rust digest must equal viem's",
            vector.token_id
        );
    }
}

#[test]
fn ack_eip712_valid_all_vectors_and_both_v_conventions() {
    setup();
    let fixture = k14();
    let recover = K256Recover;
    for vector in &fixture.valid {
        let digest = k14_digest(&fixture, vector);
        let debtor = address(&vector.debtor_evm);
        for raw in [&vector.sig, &vector.sig_v01] {
            let signer = recover_address(&recover, &digest, &signature(raw))
                .unwrap_or_else(|error| panic!("{}: {error:?}", vector.token_id));
            assert_eq!(signer, debtor, "{}: recovered debtor", vector.token_id);
        }
    }
}

#[test]
fn ack_eip712_tamper() {
    setup();
    let fixture = k14();
    let vector = &fixture.valid[0];
    let digest = k14_digest(&fixture, vector);
    let debtor = address(&vector.debtor_evm);
    let sig = signature(&vector.sig);

    let tampered = ack_digest(
        K14_ACK,
        vector.chain_id,
        &fixture.owed_contract,
        &vector.token_id,
        &bytes32(&vector.terms_hash),
        amount(vector) + 1,
        vector.due_date,
    );
    assert_ne!(tampered, digest);
    assert_ne!(
        recover_address(&K256Recover, &tampered, &sig).expect("recovers some key"),
        debtor,
        "a tampered amount must not recover the debtor"
    );

    // a signature made for another contract id
    let other_digest = ack_digest(
        K14_ACK,
        vector.chain_id,
        &fixture.other_deployment.owed_contract,
        &vector.token_id,
        &bytes32(&vector.terms_hash),
        amount(vector),
        vector.due_date,
    );
    assert_ne!(
        recover_address(
            &K256Recover,
            &other_digest,
            &signature(&fixture.sig_signed_for_other_contract)
        )
        .expect("recovers some key"),
        debtor
    );

    // a signature made for another chain id
    let other_chain = if vector.chain_id == 10 { 1 } else { 10 };
    let chain_digest = ack_digest(
        K14_ACK,
        other_chain,
        &fixture.owed_contract,
        &vector.token_id,
        &bytes32(&vector.terms_hash),
        amount(vector),
        vector.due_date,
    );
    assert_ne!(
        recover_address(&K256Recover, &chain_digest, &sig).expect("recovers some key"),
        debtor
    );
}

#[test]
fn ack_wrong_signer() {
    setup();
    let fixture = k14();
    let vector = &fixture.valid[0];
    let result = verify_ack(
        &K256Recover,
        K14_ACK,
        vector.chain_id,
        &fixture.owed_contract,
        &vector.token_id,
        &bytes32(&vector.terms_hash),
        amount(vector),
        vector.due_date,
        &address(&vector.debtor_evm),
        &signature(&fixture.wrong_signer_sig),
    );
    assert_eq!(result, Err(AckError::WrongSigner));
}

#[test]
fn ack_replay_other_invoice() {
    setup();
    let fixture = k14();
    let first = &fixture.valid[0];
    let second = &fixture.valid[1];
    let result = verify_ack(
        &K256Recover,
        K14_ACK,
        second.chain_id,
        &fixture.owed_contract,
        &second.token_id,
        &bytes32(&second.terms_hash),
        amount(second),
        second.due_date,
        &address(&second.debtor_evm),
        &signature(&first.sig),
    );
    assert_eq!(result, Err(AckError::WrongSigner));
}

#[test]
fn ack_replay_other_deployment() {
    setup();
    let fixture = k14();
    let vector = &fixture.valid[0];
    let debtor = address(&vector.debtor_evm);

    // the fixture signature verifies on the deployment it was made for …
    let other = verify_ack(
        &K256Recover,
        K14_ACK,
        vector.chain_id,
        &fixture.other_deployment.owed_contract,
        &vector.token_id,
        &bytes32(&vector.terms_hash),
        amount(vector),
        vector.due_date,
        &debtor,
        &signature(&fixture.other_deployment.ack_sig),
    );
    assert_eq!(other, Ok(debtor));

    // … and is useless on this deployment
    let main = verify_ack(
        &K256Recover,
        K14_ACK,
        vector.chain_id,
        &fixture.owed_contract,
        &vector.token_id,
        &bytes32(&vector.terms_hash),
        amount(vector),
        vector.due_date,
        &debtor,
        &signature(&fixture.other_deployment.ack_sig),
    );
    assert_eq!(main, Err(AckError::WrongSigner));
}

#[test]
fn ack_v_is_normalised() {
    setup();
    let fixture = k14();
    let vector = &fixture.valid[0];
    let digest = k14_digest(&fixture, vector);
    let debtor = address(&vector.debtor_evm);

    for raw in [&vector.sig, &vector.sig_v01] {
        assert_eq!(
            recover_address(&K256Recover, &digest, &signature(raw)),
            Ok(debtor)
        );
    }

    let mut bad = signature(&vector.sig);
    bad[64] = 29;
    assert_eq!(
        recover_address(&K256Recover, &digest, &bad),
        Err(AckError::BadV)
    );
}

#[test]
fn ack_high_s_rejected() {
    setup();
    let fixture = k14();
    let vector = &fixture.valid[0];
    let digest = k14_digest(&fixture, vector);
    assert_eq!(
        recover_address(&K256Recover, &digest, &signature(&fixture.high_s_sig)),
        Err(AckError::BadSignature)
    );
}

#[test]
fn ack_contract_wallet_refused() {
    setup();
    let fixture = k14();
    let vector = &fixture.valid[0];
    let digest = k14_digest(&fixture, vector);
    assert_eq!(
        recover_address(
            &K256Recover,
            &digest,
            &signature(&fixture.safe_contract_wallet_blob)
        ),
        Err(AckError::ContractWallet)
    );
    assert_eq!(
        recover_address(&K256Recover, &digest, &[0u8; 64]),
        Err(AckError::BadLength)
    );
}

#[derive(Deserialize)]
struct AckV1Fixture {
    ack: Vec<OpenrailAckVector>,
    cancel: Vec<OpenrailCancelVector>,
    tamper_ack: Vec<TamperAck>,
    tamper_cancel: Vec<TamperCancel>,
}

#[derive(Deserialize)]
struct OpenrailAckVector {
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

#[derive(Deserialize)]
struct OpenrailCancelVector {
    name: String,
    chain_id: u64,
    root_contract: String,
    token_id: String,
    digest: String,
    signer: String,
    signature: String,
}

#[derive(Deserialize)]
struct TamperAck {
    base: String,
    chain_id: u64,
    root_contract: String,
    token_id: String,
    terms_hash: String,
    amount_due: String,
    due_date: u64,
    digest: String,
}

#[derive(Deserialize)]
struct TamperCancel {
    base: String,
    chain_id: u64,
    root_contract: String,
    token_id: String,
    digest: String,
}

fn ack_v1() -> AckV1Fixture {
    near_sdk::serde_json::from_str(ACK_V1).expect("ack-v1.json parses")
}

fn ack_amount(vector: &OpenrailAckVector) -> u128 {
    vector.amount_due.parse().expect("amount is u128")
}

fn ack_digest_for(vector: &OpenrailAckVector) -> [u8; 32] {
    ack_digest(
        OPENRAIL_ACK,
        vector.chain_id,
        &vector.root_contract,
        &vector.token_id,
        &bytes32(&vector.terms_hash),
        ack_amount(vector),
        vector.due_date,
    )
}

#[test]
fn openrail_ack_vectors_match_viem() {
    setup();
    let fixture = ack_v1();
    assert!(fixture.ack.len() >= 10, "at least 10 ack vectors");

    let chains: BTreeSet<u64> = fixture.ack.iter().map(|vector| vector.chain_id).collect();
    for chain in [1u64, 8453, 42161, 10, 137, 56] {
        assert!(
            chains.contains(&chain),
            "ack vectors must cover chain {chain}"
        );
    }

    for vector in &fixture.ack {
        let digest = ack_digest_for(vector);
        assert_eq!(
            hex(&digest),
            vector.digest,
            "{}: Rust digest must equal viem's",
            vector.name
        );
        let signer = address(&vector.signer);
        assert_eq!(
            recover_address(&K256Recover, &digest, &signature(&vector.signature)),
            Ok(signer),
            "{}: recovered signer",
            vector.name
        );
        assert_eq!(
            verify_ack(
                &K256Recover,
                OPENRAIL_ACK,
                vector.chain_id,
                &vector.root_contract,
                &vector.token_id,
                &bytes32(&vector.terms_hash),
                ack_amount(vector),
                vector.due_date,
                &signer,
                &signature(&vector.signature),
            ),
            Ok(signer),
            "{}: verify_ack",
            vector.name
        );
    }
}

#[test]
fn openrail_cancel_vectors_match_viem() {
    setup();
    let fixture = ack_v1();
    assert!(fixture.cancel.len() >= 4, "at least 4 cancel vectors");

    let chains: BTreeSet<u64> = fixture
        .cancel
        .iter()
        .map(|vector| vector.chain_id)
        .collect();
    for chain in [1u64, 8453, 42161, 10, 137, 56] {
        assert!(
            chains.contains(&chain),
            "cancel vectors must cover chain {chain}"
        );
    }

    for vector in &fixture.cancel {
        let digest = cancel_digest(vector.chain_id, &vector.root_contract, &vector.token_id);
        assert_eq!(
            hex(&digest),
            vector.digest,
            "{}: Rust digest must equal viem's",
            vector.name
        );
        let signer = address(&vector.signer);
        assert_eq!(
            recover_address(&K256Recover, &digest, &signature(&vector.signature)),
            Ok(signer),
            "{}: recovered signer",
            vector.name
        );
        assert_eq!(
            verify_cancel(
                &K256Recover,
                vector.chain_id,
                &vector.root_contract,
                &vector.token_id,
                &signer,
                &signature(&vector.signature),
            ),
            Ok(signer),
            "{}: verify_cancel",
            vector.name
        );
    }
}

#[test]
fn openrail_tamper_vectors_are_detected() {
    setup();
    let fixture = ack_v1();
    let ack_by_name: BTreeMap<&str, &OpenrailAckVector> = fixture
        .ack
        .iter()
        .map(|vector| (vector.name.as_str(), vector))
        .collect();
    let cancel_by_name: BTreeMap<&str, &OpenrailCancelVector> = fixture
        .cancel
        .iter()
        .map(|vector| (vector.name.as_str(), vector))
        .collect();

    assert!(!fixture.tamper_ack.is_empty());
    for tamper in &fixture.tamper_ack {
        let base = ack_by_name
            .get(tamper.base.as_str())
            .unwrap_or_else(|| panic!("unknown base {}", tamper.base));
        let tampered = ack_digest(
            OPENRAIL_ACK,
            tamper.chain_id,
            &tamper.root_contract,
            &tamper.token_id,
            &bytes32(&tamper.terms_hash),
            tamper.amount_due.parse().expect("amount"),
            tamper.due_date,
        );
        assert_eq!(hex(&tampered), tamper.digest);
        assert_ne!(tampered, ack_digest_for(base));

        let debtor = address(&base.signer);
        assert_eq!(
            verify_ack(
                &K256Recover,
                OPENRAIL_ACK,
                tamper.chain_id,
                &tamper.root_contract,
                &tamper.token_id,
                &bytes32(&tamper.terms_hash),
                tamper.amount_due.parse().expect("amount"),
                tamper.due_date,
                &debtor,
                &signature(&base.signature),
            ),
            Err(AckError::WrongSigner),
            "{}: base signature must not verify the tampered message",
            tamper.base
        );
    }

    assert!(!fixture.tamper_cancel.is_empty());
    for tamper in &fixture.tamper_cancel {
        let base = cancel_by_name
            .get(tamper.base.as_str())
            .unwrap_or_else(|| panic!("unknown base {}", tamper.base));
        let tampered = cancel_digest(tamper.chain_id, &tamper.root_contract, &tamper.token_id);
        assert_eq!(hex(&tampered), tamper.digest);
        assert_ne!(
            tampered,
            cancel_digest(base.chain_id, &base.root_contract, &base.token_id)
        );
        assert_eq!(
            verify_cancel(
                &K256Recover,
                tamper.chain_id,
                &tamper.root_contract,
                &tamper.token_id,
                &address(&base.signer),
                &signature(&base.signature),
            ),
            Err(AckError::WrongSigner),
            "{}: base signature must not verify the tampered cancel",
            tamper.base
        );
    }
}
