//! Canonical terms JSON and hash (Blueprint 2.6).
//! The vectors in `fixtures/vectors/terms-v1.json` are the contract–TypeScript parity oracle.

use openrail::terms::{canonical_json, terms_hash, Terms};
use serde::Deserialize;

const FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/vectors/terms-v1.json"
));

#[derive(Deserialize)]
struct Fixture {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    input: Terms,
    expected_canonical: String,
    expected_sha256: String,
}

fn fixture() -> Fixture {
    near_sdk::serde_json::from_str(FIXTURE).expect("terms-v1.json parses")
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[test]
fn terms_canonical_matches_vectors() {
    for vector in fixture().vectors {
        let canonical = canonical_json(&vector.input)
            .unwrap_or_else(|error| panic!("{}: {error}", vector.name));
        assert_eq!(
            canonical, vector.expected_canonical,
            "{}: canonical JSON differs",
            vector.name
        );
        let hash = terms_hash(&vector.input).expect("hash");
        assert_eq!(
            hex(&hash),
            vector.expected_sha256,
            "{}: terms_hash differs",
            vector.name
        );
    }
}

#[test]
fn terms_are_utf8_and_not_ascii_escaped() {
    let vector = fixture()
        .vectors
        .into_iter()
        .find(|vector| vector.name == "unicode_names")
        .expect("unicode vector");
    let canonical = canonical_json(&vector.input).expect("canonical");
    assert!(canonical.contains("Café — Société Générale"));
    assert!(canonical.contains("株式会社オープンレール"));
    assert!(canonical.contains("счёт.near"));
    assert!(
        !canonical.contains("\\u"),
        "non-ASCII must stay UTF-8, not \\u escapes"
    );
}

#[test]
fn terms_key_order_is_sorted_and_compact() {
    let vector = fixture().vectors.remove(0);
    let canonical = canonical_json(&vector.input).expect("canonical");
    assert!(
        !canonical.contains(": ") && !canonical.contains(", "),
        "canonical JSON has no whitespace"
    );

    let keys = [
        "amount_usd",
        "claim_account",
        "clauses",
        "debtor_key",
        "debtor_legal_name",
        "due_date",
        "invoice_number",
        "issuer_account",
        "issuer_legal_name",
        "line_items_sha256",
        "pay_link",
        "schema",
    ];
    let mut previous = 0;
    for key in keys {
        let needle = format!("\"{key}\":");
        let position = canonical.find(&needle).expect("key present");
        assert!(
            position >= previous,
            "keys are not sorted at {key}: {canonical}"
        );
        previous = position;
    }
}

#[test]
fn optional_assignment_hash_is_omitted_not_null() {
    let mut vectors = fixture().vectors;
    let minimal = vectors.remove(0);
    let minimal_json = canonical_json(&minimal.input).expect("canonical");
    assert!(!minimal_json.contains("assignment_agreement_sha256"));

    let with_assignment = vectors
        .into_iter()
        .find(|vector| vector.name == "with_assignment_and_module_clause")
        .expect("assignment vector");
    let with_json = canonical_json(&with_assignment.input).expect("canonical");
    assert!(with_json.contains("\"assignment_agreement_sha256\":\"0xcdcd"));
}

#[test]
fn terms_reject_malformed_amounts() {
    let mut vector = fixture().vectors.remove(0);
    for bad in [
        "1", "1.2", "1.234", "1,00", "-1.00", "1.", ".50", " 1.00", "1.00 ",
    ] {
        vector.input.amount_usd = bad.to_string();
        assert!(
            canonical_json(&vector.input).is_err(),
            "amount {bad:?} must be rejected"
        );
    }
}

#[test]
fn terms_hash_is_sha256_of_the_canonical_string() {
    let vector = fixture().vectors.remove(0);
    let digest = terms_hash(&vector.input).expect("hash");
    assert_eq!(hex(&digest), vector.expected_sha256);
}

#[test]
fn terms_reject_malformed_hashes() {
    let mut vector = fixture().vectors.remove(0);
    let valid = vector.input.line_items_sha256.clone();
    for bad in [
        valid.trim_start_matches("0x").to_string(), // no 0x prefix
        format!("0X{}", &valid[2..]),               // uppercase prefix
        valid[..valid.len() - 1].to_string(),       // 63 hex chars
        format!("{valid}0"),                        // 65 hex chars
        format!("0x{}", "A".repeat(64)),            // uppercase hex
        format!("0x{}", "g".repeat(64)),            // not hex
        "0x".to_string(),
        String::new(),
    ] {
        vector.input.line_items_sha256 = bad;
        assert!(
            canonical_json(&vector.input).is_err(),
            "line_items_sha256 must reject {:?}",
            vector.input.line_items_sha256
        );
    }

    vector.input.line_items_sha256 = valid;
    for bad in [
        "0x1234".to_string(),
        format!("0x{}", "A".repeat(64)),
        format!("0x{}", "1".repeat(63)),
    ] {
        vector.input.assignment_agreement_sha256 = Some(bad);
        assert!(
            canonical_json(&vector.input).is_err(),
            "assignment_agreement_sha256 must reject a malformed hash"
        );
    }
    vector.input.assignment_agreement_sha256 = None;
    assert!(canonical_json(&vector.input).is_ok());
}

#[test]
fn terms_reject_malformed_due_dates() {
    let mut vector = fixture().vectors.remove(0);
    for bad in [
        "2027-01-15",
        "2027-01-15T00:00:00",
        "2027-01-15T00:00:00+00:00",
        "2027-01-15T00:00:00.000Z",
        "2027-13-01T00:00:00Z",
        "2027-00-01T00:00:00Z",
        "2027-02-29T00:00:00Z",
        "2027-01-32T00:00:00Z",
        "2027-01-15T24:00:00Z",
        "2027-01-15T00:60:00Z",
        "2027-01-15T00:00:60Z",
        "２０２７-01-15T00:00:00Z",
    ] {
        vector.input.due_date = bad.to_string();
        assert!(
            canonical_json(&vector.input).is_err(),
            "due_date must reject {bad:?}"
        );
    }
}

#[test]
fn terms_accept_valid_edge_dates() {
    let mut vector = fixture().vectors.remove(0);
    for good in [
        "2024-02-29T00:00:00Z",
        "2000-02-29T23:59:59Z",
        "1970-01-01T00:00:00Z",
        "9999-12-31T23:59:59Z",
        "2027-01-15T00:00:00Z",
    ] {
        vector.input.due_date = good.to_string();
        assert!(
            canonical_json(&vector.input).is_ok(),
            "due_date must accept {good:?}"
        );
    }
}
