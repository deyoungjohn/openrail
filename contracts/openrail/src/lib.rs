//! Openrail root contract interface (Blueprint 2.1, 2.2, 2.3, 2.4, 2.5).
//!
//! Frozen in Phase 0 (P0.3). All core method signatures, access controls, and deposit rules
//! are specified here. Bodies panic with "NOT_IMPLEMENTED" pending Phase 1 (C1–C5) implementation.
//!
//! Mainnet Protocol 86 compliance: No `near_sdk::Promise`, no `Self::ext`, no `near-contract-standards`.

#![allow(clippy::too_many_arguments)]

pub mod events;
pub mod hooks;
pub mod modules;
pub mod types;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, PanicOnDefault, PromiseOrValue};
use std::collections::HashMap;

pub use types::{
    Ack, AckScheme, Claim, ClaimView, Config, Debtor, DebtorCosig, Hex20, Hex32, HexBytes,
    JsonToken, Leg, Lock, NFTContractMetadata, Quote, Status, TokenId, TokenMetadata,
};

// ──────────────────────────────────────────────
// Canonical Constants & Storage Prefixes
// ──────────────────────────────────────────────

/// Storage prefix for claims map (`LookupMap<String, Claim>`).
pub const STORAGE_PREFIX_CLAIMS: &[u8] = b"c:";
/// Storage prefix for owner token index.
pub const STORAGE_PREFIX_OWNER_INDEX: &[u8] = b"o:";
/// Storage prefix for token metadata map.
pub const STORAGE_PREFIX_TOKEN_METADATA: &[u8] = b"t:";
/// Storage prefix for per-key append-only payment log entries (`LookupMap<(String, u64), Quote>`).
pub const STORAGE_PREFIX_PAYMENT_LOG: &[u8] = b"l:";
/// Storage prefix for payment log per-token count (`LookupMap<String, u64>`).
pub const STORAGE_PREFIX_PAYMENT_LOG_COUNT: &[u8] = b"lc:";
/// Storage prefix for undistributed legs map (`LookupMap<String, Vec<Leg>>`).
pub const STORAGE_PREFIX_UNDISTRIBUTED: &[u8] = b"u:";
/// Storage prefix for prepaid storage credits map.
pub const STORAGE_PREFIX_STORAGE_CREDIT: &[u8] = b"s:";
/// Storage key for contract configuration.
pub const STORAGE_KEY_CONFIG: &[u8] = b"cfg";

/// Canonical protocol fee: 25 basis points (0.25%).
pub const FEE_BPS: u128 = 25;

/// Transfer Rules Error Strings (Blueprint 2.4)
/// Panic messages carry the rule number in plain text.
pub const ERR_RULE_1_LOCK: &str = "Rule 1: lock must be None or TransferWindow";
pub const ERR_RULE_2_STATUS: &str = "Rule 2: status must be Issued or PartiallyPaid";
pub const ERR_RULE_3_ACK_REQUIRED: &str = "Rule 3: unacknowledged claim cannot be sold";
pub const ERR_RULE_4_ASSIGNMENT_DOC: &str = "Rule 4: assignment document hash required on sale";
pub const ERR_RULE_5_RECEIVER_NOT_CLAIM: &str = "Rule 5: receiver cannot be claim account";
pub const ERR_RULE_6_YOCTO_DEPOSIT: &str = "Rule 6: exactly 1 yoctoNEAR required";
pub const ERR_RULE_7_NOT_SELLABLE: &str = "Rule 7: kind is not sellable";
pub const ERR_RULE_8_HOOK_REFUSED: &str = "Rule 8: hook transfer check refused";

// ──────────────────────────────────────────────
// Root Contract State
// ──────────────────────────────────────────────

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub claims: LookupMap<String, Claim>,
    pub owner_index: LookupMap<AccountId, Vec<String>>,
    pub token_metadata: LookupMap<String, TokenMetadata>,
    pub payment_log: LookupMap<(String, u64), Quote>,
    pub payment_log_count: LookupMap<String, u64>,
    pub undistributed: LookupMap<String, Vec<Leg>>,
    pub storage_credit: LookupMap<AccountId, U128>,
    pub config: Config,
    pub next_token_id: u64,
}

#[near]
impl Contract {
    /// Initializes the Openrail root contract with global configuration (Blueprint 1.2, 2.1).
    ///
    /// Caller: Contract account (<root>) during initial deployment.
    #[init]
    pub fn new(config: Config) -> Self {
        Self {
            claims: LookupMap::new(STORAGE_PREFIX_CLAIMS),
            owner_index: LookupMap::new(STORAGE_PREFIX_OWNER_INDEX),
            token_metadata: LookupMap::new(STORAGE_PREFIX_TOKEN_METADATA),
            payment_log: LookupMap::new(STORAGE_PREFIX_PAYMENT_LOG),
            payment_log_count: LookupMap::new(STORAGE_PREFIX_PAYMENT_LOG_COUNT),
            undistributed: LookupMap::new(STORAGE_PREFIX_UNDISTRIBUTED),
            storage_credit: LookupMap::new(STORAGE_PREFIX_STORAGE_CREDIT),
            config,
            next_token_id: 1,
        }
    }

    // ──────────────────────────────────────────
    // Core Issuance & Storage (Blueprint 2.2)
    // ──────────────────────────────────────────

    /// Issues a new claim and mints the corresponding NEP-171 token.
    ///
    /// Caller: Anyone, unless `issue_paused`. Becomes issuer and initial owner.
    /// Deposit: Storage deposit (~0.02 NEAR); excess refunded to predecessor.
    /// Effect: Creates sub-account `c-<n>.<root>` using global vault contract by hash,
    ///         mints token (NEP-171 `nft_mint` event), and emits `issue`.
    #[payable]
    pub fn issue(
        &mut self,
        kind: u8,
        debtor: Option<Debtor>,
        terms_hash: Hex32,
        amount_due: U128,
        due_date: u64,
        metadata: Option<TokenMetadata>,
    ) -> String {
        let _ = (kind, debtor, terms_hash, amount_due, due_date, metadata);
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Issues a new claim on behalf of a registered business using prepaid storage credits.
    ///
    /// Caller: Allow-listed `issuer` in `config.issuers` (function-call key; attached deposit 0).
    /// Deposit: None attached; storage cost debited from `storage_credit[business]`.
    /// Effect: Mints token to `business`. Panics `NO_STORAGE_CREDIT` if credit is insufficient.
    pub fn issue_for(
        &mut self,
        business: AccountId,
        kind: u8,
        debtor: Option<Debtor>,
        terms_hash: Hex32,
        amount_due: U128,
        due_date: u64,
        metadata: Option<TokenMetadata>,
    ) -> String {
        let _ = (
            business, kind, debtor, terms_hash, amount_due, due_date, metadata,
        );
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Prepays storage credit for API invoice issuance.
    ///
    /// Caller: The business account.
    /// Deposit: Attached NEAR deposit credited to `storage_credit[predecessor]`.
    #[payable]
    pub fn deposit_storage_credit(&mut self) {
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Withdraws unused prepaid storage credit.
    ///
    /// Caller: The business account.
    /// Deposit: None. Refunds requested amount from `storage_credit[predecessor]` to caller.
    pub fn withdraw_storage_credit(&mut self, amount: U128) {
        let _ = amount;
        env::panic_str("NOT_IMPLEMENTED");
    }

    // ──────────────────────────────────────────
    // Debtor Acknowledgment (Blueprint 2.2, 2.7)
    // ──────────────────────────────────────────

    /// Debtor acknowledgment via NEAR predecessor or relayed NEP-366 meta-transaction.
    ///
    /// Caller: Must match `claim.debtor == Near(predecessor)`.
    /// Deposit: None. Write-once: sets `ack` and emits `ack` event.
    pub fn acknowledge_near(&mut self, token_id: String) {
        let _ = token_id;
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Debtor acknowledgment via EIP-712 signature on EVM key.
    ///
    /// Caller: Anyone (relays signature).
    /// Deposit: None. Verifies EIP-712 signature with `env::ecrecover`;
    ///         recovered address must equal `claim.debtor == Evm(address)`.
    pub fn acknowledge_evm(&mut self, token_id: String, chain_id: u64, sig: HexBytes) {
        let _ = (token_id, chain_id, sig);
        env::panic_str("NOT_IMPLEMENTED");
    }

    // ──────────────────────────────────────────
    // Reconcile, Distribution & Pumps (Blueprint 2.2, 2.5)
    // ──────────────────────────────────────────

    /// Reconciles newly observed balances on `claim_account` against settlement assets.
    ///
    /// Caller: Anyone (permissionless; watcher pumps periodically).
    /// Deposit: None.
    /// Effect: Acquires `Reconciling` lock, reads `mt_batch_balance_of` on `intents.near`,
    ///         books payment/credit, and starts distribution forwards.
    pub fn reconcile(&mut self, token_id: String) {
        let _ = token_id;
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Retries failed distribution legs to their originally recorded receivers.
    ///
    /// Caller: Anyone.
    /// Deposit: None. Invariant D-S8: receiver is fixed at booking; removes succeeding legs.
    pub fn retry_distribution(&mut self, token_id: String) {
        let _ = token_id;
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Clears expired locks (`Reconciling` > 100 blocks, or `Module`/`TransferWindow` past until).
    ///
    /// Caller: Anyone.
    /// Deposit: None. Resets lock to `None` without booking; emits `lock_cleared`.
    pub fn clear_stale_lock(&mut self, token_id: String) {
        let _ = token_id;
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Prepares claim for sale/transfer by opening a bounded transfer window.
    ///
    /// Caller: Claim owner only.
    /// Deposit: None.
    /// Effect: Runs reconcile; callback opens `TransferWindow { until: now + 1800 blocks }`
    ///         if `hooks::check_transfer` passes.
    pub fn prepare_transfer(&mut self, token_id: String) {
        let _ = token_id;
        env::panic_str("NOT_IMPLEMENTED");
    }

    // ──────────────────────────────────────────
    // NEP-171 Non-Fungible Token Core (Blueprint 2.2, 2.4)
    // ──────────────────────────────────────────

    /// Transfers claim ownership adhering to Blueprint 2.4 rules.
    ///
    /// Caller: Owner or approved account.
    /// Deposit: Exactly 1 yoctoNEAR (Rule 6).
    /// Enforces: Rules 1–8; panic messages carry rule numbers.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        let _ = (receiver_id, token_id, approval_id, memo);
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Transfers claim ownership and calls `nft_on_transfer` on receiver.
    ///
    /// Caller: Owner or approved account.
    /// Deposit: Exactly 1 yoctoNEAR (Rule 6).
    /// Effect: Keeps transfer window lock active while receiver executes.
    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        let _ = (receiver_id, token_id, approval_id, memo, msg);
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Callback resolving `nft_transfer_call`.
    ///
    /// Caller: Private (`predecessor == current_account`).
    /// Effect: Restores previous owner if receiver returned true or panicked.
    #[private]
    pub fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        let _ = (
            previous_owner_id,
            receiver_id,
            token_id,
            approved_account_ids,
        );
        env::panic_str("NOT_IMPLEMENTED");
    }

    // ──────────────────────────────────────────
    // NEP-178 Approvals (Blueprint 2.2)
    // ──────────────────────────────────────────

    /// Approves an account to transfer the specified claim.
    ///
    /// Caller: Claim owner only.
    /// Deposit: Storage deposit for approval record (at least 1 yoctoNEAR).
    #[payable]
    pub fn nft_approve(
        &mut self,
        token_id: String,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<u64> {
        let _ = (token_id, account_id, msg);
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Revokes an approved account for the specified claim.
    ///
    /// Caller: Claim owner only.
    /// Deposit: Exactly 1 yoctoNEAR.
    #[payable]
    pub fn nft_revoke(&mut self, token_id: String, account_id: AccountId) {
        let _ = (token_id, account_id);
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Revokes all approved accounts for the specified claim.
    ///
    /// Caller: Claim owner only.
    /// Deposit: Exactly 1 yoctoNEAR.
    #[payable]
    pub fn nft_revoke_all(&mut self, token_id: String) {
        let _ = token_id;
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Checks if an account is approved for transfer.
    pub fn nft_is_approved(
        &self,
        token_id: String,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool {
        let _ = (token_id, approved_account_id, approval_id);
        env::panic_str("NOT_IMPLEMENTED");
    }

    // ──────────────────────────────────────────
    // NEP-177 Metadata & NEP-181 Enumeration (Blueprint 2.2)
    // ──────────────────────────────────────────

    /// Returns contract-level metadata (spec "nft-1.0.0").
    pub fn nft_metadata(&self) -> NFTContractMetadata {
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Returns token details including owner and metadata.
    pub fn nft_token(&self, token_id: String) -> Option<JsonToken> {
        let _ = token_id;
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Returns total number of active tokens.
    pub fn nft_total_supply(&self) -> U128 {
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Enumerates tokens paginated.
    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let _ = (from_index, limit);
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Returns number of tokens owned by the given account.
    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        let _ = account_id;
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Enumerates tokens owned by the given account paginated.
    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<JsonToken> {
        let _ = (account_id, from_index, limit);
        env::panic_str("NOT_IMPLEMENTED");
    }

    // ──────────────────────────────────────────
    // Claim Lifecycle & Management (Blueprint 2.2)
    // ──────────────────────────────────────────

    /// Cancels an unpaid claim.
    ///
    /// Caller: Claim owner.
    /// Requirements: `booked_total == 0`, `credit_total == 0`, `lock == None`,
    ///               and `hooks::check_cancel` passes.
    /// Post-ack: Requires debtor co-signature (EVM EIP-712 or NEAR caller).
    pub fn cancel(&mut self, token_id: String, debtor_cosig: Option<DebtorCosig>) {
        let _ = (token_id, debtor_cosig);
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Formally closes a fully paid claim (`Paid` -> `Closed`).
    ///
    /// Caller: Claim owner.
    /// Requirements: `status == Paid`, `surplus == 0`, `lock == None`.
    pub fn close(&mut self, token_id: String) {
        let _ = token_id;
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Closes a partially paid claim recording the shortfall (`PartiallyPaid` -> `Closed`).
    ///
    /// Caller: Claim owner.
    /// Requirements: `status == PartiallyPaid`, `hooks::check_writeoff` passes.
    pub fn close_writeoff(&mut self, token_id: String) {
        let _ = token_id;
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Releases accumulated surplus to the current claim owner.
    ///
    /// Caller: Claim owner.
    /// Deposit: None. Forwards surplus value to owner_id; emits `surplus_released`.
    pub fn release_surplus(&mut self, token_id: String) {
        let _ = token_id;
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Appends a Quote log entry before a payment deposit address is returned.
    ///
    /// Caller: Allow-listed `quote_writer`. Duplicate `quote_id` panics.
    pub fn log_quote(&mut self, token_id: String, quote: Quote) {
        let _ = (token_id, quote);
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Updates administrative contract parameters.
    ///
    /// Caller: Root account `<root>` only. Emits `config_changed`.
    pub fn set_config(
        &mut self,
        settlement_assets: Option<Vec<TokenId>>,
        vault_code_hash: Option<Hex32>,
        fee_account: Option<AccountId>,
        issue_paused: Option<bool>,
        watchers: Option<Vec<AccountId>>,
        quote_writers: Option<Vec<AccountId>>,
        issuers: Option<Vec<AccountId>>,
    ) {
        let _ = (
            settlement_assets,
            vault_code_hash,
            fee_account,
            issue_paused,
            watchers,
            quote_writers,
            issuers,
        );
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Pauses or unpauses claim issuance.
    ///
    /// Caller: Root account `<root>` only. Emits `config_changed`.
    pub fn pause_issue(&mut self, paused: bool) {
        let _ = paused;
        env::panic_str("NOT_IMPLEMENTED");
    }

    // ──────────────────────────────────────────
    // Views (Blueprint 2.2)
    // ──────────────────────────────────────────

    /// Returns the full Claim record along with undistributed legs by `token_id`.
    pub fn claim(&self, token_id: String) -> Option<ClaimView> {
        let _ = token_id;
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Returns claims issued by the given account, paginated.
    pub fn claims_by_issuer(
        &self,
        account: AccountId,
        from: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<ClaimView> {
        let _ = (account, from, limit);
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Returns outstanding amount due on the claim in USDC base units.
    pub fn outstanding(&self, token_id: String) -> Option<U128> {
        let _ = token_id;
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Returns payment log quotes for the given claim, paginated.
    pub fn payment_log(
        &self,
        token_id: String,
        from: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<Quote> {
        let _ = (token_id, from, limit);
        env::panic_str("NOT_IMPLEMENTED");
    }

    /// Returns global contract configuration.
    pub fn config(&self) -> Config {
        env::panic_str("NOT_IMPLEMENTED");
    }
}

// ──────────────────────────────────────────
// Synchronous Module Functions (Blueprint 1.4)
// ──────────────────────────────────────────

impl Contract {
    /// Applies a value-less credit from an enabled module outside of reconcile (Blueprint 1.4).
    ///
    /// Callable synchronously by enabled modules.
    /// Rules:
    /// - `claim.lock == Lock::None`
    /// - At most one `credit_source` per claim, ever (write-once)
    /// - `credit_total + amount <= amount_due - (booked_total - surplus)` (i.e. `credit <= outstanding`)
    #[allow(dead_code)]
    pub(crate) fn apply_credit(&mut self, token_id: &str, amount: U128, source: u8) {
        let _ = (token_id, amount, source);
        env::panic_str("NOT_IMPLEMENTED");
    }
}
