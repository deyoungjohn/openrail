//! EIP-712 digests for the acknowledgement and cancel co-signature (Blueprint 2.7).
//!
//! Domain: `{ name: "Openrail", version: "1", chainId: <wallet chain>, verifyingContract: 0x00…00 }`.
//! - Ack: `Acknowledge(string kind,string rootContract,string tokenId,bytes32 termsHash,uint256 amountDue,uint64 dueDate)`
//!   with `kind = "OPENRAIL_ACK_V1"`.
//! - Cancel: `Cancel(string kind,string rootContract,string tokenId)` with
//!   `kind = "OPENRAIL_CANCEL_V1"`.
//!
//! Recovery is behind [`Ecrecover`] so the vectors can run on the host with a pure-Rust
//! verifier, while production uses [`EnvEcrecover`] (`env::ecrecover`,
//! `malleability_flag = true`). `v` is normalised (27/28 and 0/1); high-`s` is rejected;
//! EIP-1271 contract-wallet blobs are refused.
//!
//! The K14 vectors use the earlier `Owed` domain; [`K14_ACK`] runs the same algorithm with
//! the fixture's names so those 20 viem digests stay a parity oracle. Production always uses
//! [`OPENRAIL_ACK`] / [`cancel_digest`].

pub const DOMAIN_NAME: &str = "Openrail";
pub const DOMAIN_VERSION: &str = "1";
pub const ACK_KIND: &str = "OPENRAIL_ACK_V1";
pub const CANCEL_KIND: &str = "OPENRAIL_CANCEL_V1";
pub const ROOT_FIELD: &str = "rootContract";

const DOMAIN_TYPE: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

/// Parameter set for the acknowledgement type. Production uses [`OPENRAIL_ACK`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AckScheme {
    pub domain_name: &'static str,
    pub kind: &'static str,
    pub root_field: &'static str,
}

/// The production scheme (Blueprint 2.7).
pub const OPENRAIL_ACK: AckScheme = AckScheme {
    domain_name: DOMAIN_NAME,
    kind: ACK_KIND,
    root_field: ROOT_FIELD,
};

/// The K14 fixture's scheme, used only to check the algorithm against viem's digests.
pub const K14_ACK: AckScheme = AckScheme {
    domain_name: "Owed",
    kind: "OWED_ACK_V1",
    root_field: "owedContract",
};

fn keccak(bytes: &[u8]) -> [u8; 32] {
    near_sdk::env::keccak256_array(bytes)
}

fn word_u64(value: u64) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

fn word_u128(value: u128) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

/// `keccak256` of the EIP-712 domain with `verifyingContract = 0x00…00`.
pub fn domain_separator(domain_name: &str, chain_id: u64) -> [u8; 32] {
    let mut encoded = Vec::with_capacity(5 * 32);
    encoded.extend_from_slice(&keccak(DOMAIN_TYPE.as_bytes()));
    encoded.extend_from_slice(&keccak(domain_name.as_bytes()));
    encoded.extend_from_slice(&keccak(DOMAIN_VERSION.as_bytes()));
    encoded.extend_from_slice(&word_u64(chain_id));
    encoded.extend_from_slice(&[0u8; 32]);
    keccak(&encoded)
}

pub fn ack_type_string(root_field: &str) -> String {
    format!(
        "Acknowledge(string kind,string {root_field},string tokenId,bytes32 termsHash,uint256 amountDue,uint64 dueDate)"
    )
}

pub fn ack_struct_hash(
    scheme: AckScheme,
    root_contract: &str,
    token_id: &str,
    terms_hash: &[u8; 32],
    amount_due: u128,
    due_date: u64,
) -> [u8; 32] {
    let mut encoded = Vec::with_capacity(7 * 32);
    encoded.extend_from_slice(&keccak(ack_type_string(scheme.root_field).as_bytes()));
    encoded.extend_from_slice(&keccak(scheme.kind.as_bytes()));
    encoded.extend_from_slice(&keccak(root_contract.as_bytes()));
    encoded.extend_from_slice(&keccak(token_id.as_bytes()));
    encoded.extend_from_slice(terms_hash);
    encoded.extend_from_slice(&word_u128(amount_due));
    encoded.extend_from_slice(&word_u64(due_date));
    keccak(&encoded)
}

/// `keccak256(0x19 0x01 ‖ domainSeparator ‖ structHash)` for `Acknowledge`.
pub fn ack_digest(
    scheme: AckScheme,
    chain_id: u64,
    root_contract: &str,
    token_id: &str,
    terms_hash: &[u8; 32],
    amount_due: u128,
    due_date: u64,
) -> [u8; 32] {
    let domain = domain_separator(scheme.domain_name, chain_id);
    let struct_hash = ack_struct_hash(
        scheme,
        root_contract,
        token_id,
        terms_hash,
        amount_due,
        due_date,
    );
    let mut encoded = Vec::with_capacity(66);
    encoded.extend_from_slice(&[0x19, 0x01]);
    encoded.extend_from_slice(&domain);
    encoded.extend_from_slice(&struct_hash);
    keccak(&encoded)
}

pub fn cancel_type_string() -> String {
    format!("Cancel(string kind,string {ROOT_FIELD},string tokenId)")
}

pub fn cancel_struct_hash(kind: &str, root_contract: &str, token_id: &str) -> [u8; 32] {
    let mut encoded = Vec::with_capacity(4 * 32);
    encoded.extend_from_slice(&keccak(cancel_type_string().as_bytes()));
    encoded.extend_from_slice(&keccak(kind.as_bytes()));
    encoded.extend_from_slice(&keccak(root_contract.as_bytes()));
    encoded.extend_from_slice(&keccak(token_id.as_bytes()));
    keccak(&encoded)
}

/// Same domain as the acknowledgement, with `{kind, rootContract, tokenId}`.
pub fn cancel_digest(chain_id: u64, root_contract: &str, token_id: &str) -> [u8; 32] {
    let domain = domain_separator(DOMAIN_NAME, chain_id);
    let struct_hash = cancel_struct_hash(CANCEL_KIND, root_contract, token_id);
    let mut encoded = Vec::with_capacity(66);
    encoded.extend_from_slice(&[0x19, 0x01]);
    encoded.extend_from_slice(&domain);
    encoded.extend_from_slice(&struct_hash);
    keccak(&encoded)
}

/// ECDSA recovery, injectable so tests can use a pure-Rust verifier.
pub trait Ecrecover {
    fn ecrecover(
        &self,
        digest: &[u8; 32],
        signature: &[u8; 64],
        recovery_id: u8,
        malleability_flag: bool,
    ) -> Option<[u8; 64]>;
}

/// Production recovery: `env::ecrecover` with the malleability flag on.
pub struct EnvEcrecover;

impl Ecrecover for EnvEcrecover {
    fn ecrecover(
        &self,
        digest: &[u8; 32],
        signature: &[u8; 64],
        recovery_id: u8,
        malleability_flag: bool,
    ) -> Option<[u8; 64]> {
        near_sdk::env::ecrecover(digest, signature, recovery_id, malleability_flag)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AckError {
    BadLength,
    BadV,
    BadSignature,
    WrongSigner,
    ContractWallet,
}

/// Recovers the 20-byte Ethereum address for a 65-byte `r ‖ s ‖ v` signature.
///
/// `v` accepts 27/28 and 0/1; anything else is `BadV`. High-`s` is rejected by the
/// malleability flag. A Safe-style blob (`v = 0` with an address in `r`) is refused before
/// recovery because EIP-1271 is not supported.
pub fn recover_address<R: Ecrecover>(
    recover: &R,
    digest: &[u8; 32],
    signature: &[u8],
) -> Result<[u8; 20], AckError> {
    if signature.len() != 65 {
        return Err(AckError::BadLength);
    }
    let v = signature[64];
    if v == 0 && signature[..12].iter().all(|byte| *byte == 0) {
        return Err(AckError::ContractWallet);
    }
    let recovery_id = match v {
        27 | 28 => v - 27,
        v @ (0 | 1) => v,
        _ => return Err(AckError::BadV),
    };
    let signature64: [u8; 64] = signature[..64]
        .try_into()
        .map_err(|_| AckError::BadLength)?;
    let public_key = recover
        .ecrecover(digest, &signature64, recovery_id, true)
        .ok_or(AckError::BadSignature)?;
    let hash = keccak(&public_key);
    let mut address = [0u8; 20];
    address.copy_from_slice(&hash[12..]);
    Ok(address)
}

/// Computes the ack digest, recovers the signer and requires the debtor's address.
pub fn verify_ack<R: Ecrecover>(
    recover: &R,
    scheme: AckScheme,
    chain_id: u64,
    root_contract: &str,
    token_id: &str,
    terms_hash: &[u8; 32],
    amount_due: u128,
    due_date: u64,
    debtor: &[u8; 20],
    signature: &[u8],
) -> Result<[u8; 20], AckError> {
    let digest = ack_digest(
        scheme,
        chain_id,
        root_contract,
        token_id,
        terms_hash,
        amount_due,
        due_date,
    );
    let signer = recover_address(recover, &digest, signature)?;
    if &signer != debtor {
        return Err(AckError::WrongSigner);
    }
    Ok(signer)
}

/// Computes the cancel digest, recovers the signer and requires the debtor's address.
pub fn verify_cancel<R: Ecrecover>(
    recover: &R,
    chain_id: u64,
    root_contract: &str,
    token_id: &str,
    debtor: &[u8; 20],
    signature: &[u8],
) -> Result<[u8; 20], AckError> {
    let digest = cancel_digest(chain_id, root_contract, token_id);
    let signer = recover_address(recover, &digest, signature)?;
    if &signer != debtor {
        return Err(AckError::WrongSigner);
    }
    Ok(signer)
}
