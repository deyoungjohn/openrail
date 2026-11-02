//! Canonical terms JSON and `terms_hash` (Blueprint 2.6).
//!
//! Canonical form: a JSON object whose keys are sorted at every level, UTF-8, with no
//! whitespace. Strings use JSON escaping (quote, backslash, short escapes for
//! `\b \f \n \r \t`, `\u00XX` for other control characters); non-ASCII stays UTF-8.
//! `terms_hash = sha256(canonical UTF-8 bytes)`.
//!
//! Money is always a JSON string with exactly two decimals (`amount_usd`).
//! Optional fields are omitted, never `null`.
//!
//! The same vectors are in `fixtures/vectors/terms-v1.json`; the TypeScript implementation
//! must reproduce them byte for byte.

use near_sdk::near;
use near_sdk::serde_json::{self, Value};
use std::collections::BTreeMap;

pub const TERMS_SCHEMA: &str = "openrail.terms.v1";

/// Core clause `payment_instruction_v1` (Blueprint 2.6).
pub const CLAUSE_PAYMENT_INSTRUCTION_V1: &str = "Payment of any amount to any address listed in this invoice or at its pay link discharges this invoice to that extent.";

/// Core clause `assignment_consent_v1` (Blueprint 2.6).
pub const CLAUSE_ASSIGNMENT_CONSENT_V1: &str = "The debtor consents to the assignment of the right to receive payment; the payment addresses do not change on assignment.";

/// The core clause list in canonical order (core first, then module clauses).
pub fn core_clauses() -> Vec<String> {
    vec![
        CLAUSE_PAYMENT_INSTRUCTION_V1.to_string(),
        CLAUSE_ASSIGNMENT_CONSENT_V1.to_string(),
    ]
}

/// Terms input from the issuer. The canonical JSON adds `schema` first and omits
/// `assignment_agreement_sha256` when it is `None`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Terms {
    pub schema: String,
    pub invoice_number: String,
    pub issuer_legal_name: String,
    pub issuer_account: String,
    pub debtor_legal_name: String,
    pub debtor_key: String,
    /// String with exactly two decimals, e.g. `"1234.50"`.
    pub amount_usd: String,
    /// ISO 8601, e.g. `"2027-01-15T00:00:00Z"`.
    pub due_date: String,
    pub line_items_sha256: String,
    pub claim_account: String,
    pub pay_link: String,
    pub assignment_agreement_sha256: Option<String>,
    /// Core clauses first, then module clauses; input order is preserved.
    pub clauses: Vec<String>,
}

/// Validates the fields whose canonical form is fixed by Blueprint 2.6.
pub fn validate(terms: &Terms) -> Result<(), String> {
    if terms.schema != TERMS_SCHEMA {
        return Err(format!("schema must be {TERMS_SCHEMA}"));
    }
    if !is_two_decimal_amount(&terms.amount_usd) {
        return Err("amount_usd must be a string with exactly two decimals".to_string());
    }
    if terms.amount_usd.len() > 40 {
        return Err("amount_usd is too large".to_string());
    }
    if !is_lower_hex32(&terms.line_items_sha256) {
        return Err(
            "line_items_sha256 must be 0x followed by 64 lowercase hex characters".to_string(),
        );
    }
    if let Some(hash) = &terms.assignment_agreement_sha256 {
        if !is_lower_hex32(hash) {
            return Err(
                "assignment_agreement_sha256 must be 0x followed by 64 lowercase hex characters"
                    .to_string(),
            );
        }
    }
    if !is_iso8601_utc(&terms.due_date) {
        return Err(
            "due_date must be an ISO 8601 UTC timestamp in YYYY-MM-DDTHH:MM:SSZ form".to_string(),
        );
    }
    Ok(())
}

fn is_lower_hex32(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("0x") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Exact `YYYY-MM-DDTHH:MM:SSZ` with a real calendar date and wall-clock time.
fn is_iso8601_utc(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'Z'
    {
        return false;
    }
    let digits = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18];
    if !digits.iter().all(|&index| bytes[index].is_ascii_digit()) {
        return false;
    }
    let number = |start: usize, len: usize| -> u32 {
        bytes[start..start + len]
            .iter()
            .fold(0u32, |acc, byte| acc * 10 + u32::from(byte - b'0'))
    };
    let year = number(0, 4) as i64;
    let month = number(5, 2);
    let day = number(8, 2);
    let hour = number(11, 2);
    let minute = number(14, 2);
    let second = number(17, 2);

    (1..=12).contains(&month)
        && day >= 1
        && day <= days_in_month(year, month)
        && hour <= 23
        && minute <= 59
        && second <= 59
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn is_two_decimal_amount(value: &str) -> bool {
    let Some((whole, fraction)) = value.split_once('.') else {
        return false;
    };
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.len() == 2
        && fraction.bytes().all(|b| b.is_ascii_digit())
}

/// Canonical terms JSON: sorted keys, UTF-8, no whitespace.
pub fn canonical_json(terms: &Terms) -> Result<String, String> {
    validate(terms)?;

    let mut map: BTreeMap<&str, Value> = BTreeMap::new();
    map.insert("schema", Value::String(terms.schema.clone()));
    map.insert(
        "invoice_number",
        Value::String(terms.invoice_number.clone()),
    );
    map.insert(
        "issuer_legal_name",
        Value::String(terms.issuer_legal_name.clone()),
    );
    map.insert(
        "issuer_account",
        Value::String(terms.issuer_account.clone()),
    );
    map.insert(
        "debtor_legal_name",
        Value::String(terms.debtor_legal_name.clone()),
    );
    map.insert("debtor_key", Value::String(terms.debtor_key.clone()));
    map.insert("amount_usd", Value::String(terms.amount_usd.clone()));
    map.insert("due_date", Value::String(terms.due_date.clone()));
    map.insert(
        "line_items_sha256",
        Value::String(terms.line_items_sha256.clone()),
    );
    map.insert("claim_account", Value::String(terms.claim_account.clone()));
    map.insert("pay_link", Value::String(terms.pay_link.clone()));
    if let Some(hash) = &terms.assignment_agreement_sha256 {
        map.insert("assignment_agreement_sha256", Value::String(hash.clone()));
    }
    map.insert(
        "clauses",
        Value::Array(terms.clauses.iter().cloned().map(Value::String).collect()),
    );

    serde_json::to_string(&map).map_err(|error| error.to_string())
}

/// `sha256(canonical terms JSON)`.
pub fn terms_hash(terms: &Terms) -> Result<[u8; 32], String> {
    let canonical = canonical_json(terms)?;
    Ok(near_sdk::env::sha256_array(canonical.as_bytes()))
}
