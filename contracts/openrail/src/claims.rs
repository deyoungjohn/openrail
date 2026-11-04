//! Claims state management and domain invariants (Blueprint 2.1, 2.3).

use crate::types::{Claim, Lock, Status};
use crate::Contract;
use near_sdk::{env, require, AccountId, Gas, NearToken};

/// Minimum attached deposit required to issue a claim (~0.02 NEAR).
pub const REQUIRED_ISSUE_DEPOSIT: NearToken = NearToken::from_millinear(20);

/// Balance transferred to initialize the keyless vault sub-account.
pub const ACCOUNT_CREATION_TRANSFER: NearToken = NearToken::from_millinear(10);

/// Gas allocated for the `on_issue` callback execution.
pub const GAS_FOR_ON_ISSUE: Gas = Gas::from_tgas(30);

/// Formats the token ID for a claim given its sequential number.
pub fn format_token_id(n: u64) -> String {
    format!("c-{n}")
}

/// Formats the dedicated claim sub-account ID (`c-<n>.<root>`).
pub fn format_claim_account(token_id: &str, root: &AccountId) -> AccountId {
    format!("{token_id}.{root}")
        .parse()
        .expect("valid claim account id")
}

/// Computes the outstanding balance on a claim (Blueprint 2.3).
///
/// Outstanding = `amount_due − (booked_total − surplus) − credit_total`.
pub fn compute_outstanding(claim: &Claim) -> u128 {
    let booked_net = claim.booked_total.0.saturating_sub(claim.surplus.0);
    let discharged = booked_net.saturating_add(claim.credit_total.0);
    claim.amount_due.0.saturating_sub(discharged)
}

/// An `IterableSet`/`UnorderedSet`-style storage set backed by a unique storage prefix.
///
/// Stores:
/// - `{prefix}:n` -> `u64` count of elements (8-byte little-endian)
/// - `{prefix}:i:{idx_le}` -> element `String` at index `0 <= idx < count`
/// - `{prefix}:k:{token_id}` -> `u64` index of `token_id` (8-byte little-endian)
///
/// Provides O(1) `insert`, O(1) `remove` (swap-remove with uniform storage operations),
/// O(1) `len`, and O(limit) `iter_range(from, limit)` pagination without loading skipped elements.
pub(crate) struct IndexedTokenSet {
    prefix: Vec<u8>,
}

impl IndexedTokenSet {
    /// Per-owner token set with unique storage prefix `b"o:{owner}"`.
    pub(crate) fn for_owner(owner: &AccountId) -> Self {
        let mut prefix =
            Vec::with_capacity(crate::STORAGE_PREFIX_OWNER_INDEX.len() + owner.as_bytes().len());
        prefix.extend_from_slice(crate::STORAGE_PREFIX_OWNER_INDEX);
        prefix.extend_from_slice(owner.as_bytes());
        Self { prefix }
    }

    /// Global active token set with storage prefix `b"ti:"`.
    pub(crate) fn global() -> Self {
        Self {
            prefix: crate::STORAGE_PREFIX_TOKEN_INDEX.to_vec(),
        }
    }

    fn len_key(&self) -> Vec<u8> {
        let mut key = Vec::with_capacity(self.prefix.len() + 2);
        key.extend_from_slice(&self.prefix);
        key.extend_from_slice(b":n");
        key
    }

    fn item_at_key(&self, idx: u64) -> Vec<u8> {
        let mut key = Vec::with_capacity(self.prefix.len() + 3 + 8);
        key.extend_from_slice(&self.prefix);
        key.extend_from_slice(b":i:");
        key.extend_from_slice(&idx.to_le_bytes());
        key
    }

    fn index_of_bytes_key(&self, token_id: &[u8]) -> Vec<u8> {
        let mut key = Vec::with_capacity(self.prefix.len() + 3 + token_id.len());
        key.extend_from_slice(&self.prefix);
        key.extend_from_slice(b":k:");
        key.extend_from_slice(token_id);
        key
    }

    pub(crate) fn len(&self) -> u64 {
        env::storage_read(&self.len_key())
            .and_then(|bytes| bytes.try_into().ok().map(u64::from_le_bytes))
            .unwrap_or(0)
    }

    pub(crate) fn get(&self, idx: u64) -> Option<String> {
        env::storage_read(&self.item_at_key(idx)).and_then(|bytes| String::from_utf8(bytes).ok())
    }

    pub(crate) fn insert(&mut self, token_id: &str) -> bool {
        let k_key = self.index_of_bytes_key(token_id.as_bytes());
        if env::storage_has_key(&k_key) {
            return false;
        }
        let idx = self.len();
        let i_key = self.item_at_key(idx);
        let n_key = self.len_key();
        env::storage_write(&i_key, token_id.as_bytes());
        env::storage_write(&k_key, &idx.to_le_bytes());
        env::storage_write(&n_key, &(idx + 1).to_le_bytes());
        true
    }

    pub(crate) fn remove(&mut self, token_id: &str) -> bool {
        let k_key = self.index_of_bytes_key(token_id.as_bytes());
        let Some(idx_bytes) = env::storage_read(&k_key) else {
            return false;
        };
        let idx = u64::from_le_bytes(idx_bytes.try_into().expect("valid u64 index"));
        let len = self.len();
        let last_idx = len.checked_sub(1).expect("non-empty set on remove");
        let last_i_key = self.item_at_key(last_idx);
        let last_token = env::storage_read(&last_i_key).expect("last token must exist");
        let last_k_key = self.index_of_bytes_key(&last_token);
        let idx_i_key = self.item_at_key(idx);

        // Execute uniform swap-write then remove so gas cost is constant regardless of idx == last_idx.
        env::storage_write(&idx_i_key, &last_token);
        env::storage_write(&last_k_key, &idx.to_le_bytes());
        env::storage_remove(&last_i_key);
        env::storage_remove(&k_key);

        let n_key = self.len_key();
        env::storage_write(&n_key, &last_idx.to_le_bytes());
        true
    }

    pub(crate) fn iter_range(
        &self,
        from: usize,
        limit: usize,
    ) -> impl Iterator<Item = String> + '_ {
        let total = self.len() as usize;
        let start = from.min(total);
        let end = start.saturating_add(limit).min(total);
        (start..end).filter_map(move |idx| self.get(idx as u64))
    }
}

impl Contract {
    /// Asserts that the caller is the contract itself (`<root>`).
    pub(crate) fn assert_root_only(&self) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Unauthorized: root only"
        );
    }

    /// Adds a token ID to the global token index set.
    pub(crate) fn internal_add_global_token(&mut self, token_id: &str) {
        IndexedTokenSet::global().insert(token_id);
    }

    /// Adds a token ID to the owner's per-account token set.
    #[allow(dead_code)]
    pub(crate) fn internal_add_owner_token(&mut self, owner: &AccountId, token_id: &str) {
        IndexedTokenSet::for_owner(owner).insert(token_id);
    }

    /// Removes a token ID from the owner's per-account token set.
    #[allow(dead_code)]
    pub(crate) fn internal_remove_owner_token(&mut self, owner: &AccountId, token_id: &str) {
        IndexedTokenSet::for_owner(owner).remove(token_id);
    }

    /// Formally closes a fully paid claim (`Paid` -> `Closed`).
    ///
    /// Caller: Claim owner.
    /// Requirements: `status == Paid`, `surplus == 0`, `lock == None`.
    pub(crate) fn internal_close(&mut self, token_id: String) {
        let mut claim = self
            .claims
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("claim not found"));

        require!(
            env::predecessor_account_id() == claim.owner_id,
            "Unauthorized: owner only"
        );
        require!(claim.status == Status::Paid, "claim is not Paid");
        require!(claim.surplus.0 == 0, "claim has unreleased surplus");
        require!(claim.lock == Lock::None, "claim is locked");

        claim.status = Status::Closed;
        self.claims.insert(token_id.clone(), claim);

        crate::events::CloseEvent { token_id }.emit();
    }

    /// Closes a partially paid claim recording the shortfall (`PartiallyPaid` -> `Closed`).
    ///
    /// Caller: Claim owner.
    /// Requirements: `status == PartiallyPaid`, `hooks::check_writeoff` passes.
    pub(crate) fn internal_close_writeoff(&mut self, token_id: String) {
        let mut claim = self
            .claims
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("claim not found"));

        require!(
            env::predecessor_account_id() == claim.owner_id,
            "Unauthorized: owner only"
        );
        require!(
            claim.status == Status::PartiallyPaid,
            "claim is not PartiallyPaid"
        );
        require!(claim.lock == Lock::None, "claim is locked");

        if let Err(refusal) = crate::hooks::dispatch_check_writeoff(&claim) {
            env::panic_str(&format!("writeoff refused: {refusal}"));
        }

        let shortfall = compute_outstanding(&claim);
        claim.status = Status::Closed;
        self.claims.insert(token_id.clone(), claim);

        crate::events::WriteoffEvent {
            token_id,
            shortfall: near_sdk::json_types::U128(shortfall),
        }
        .emit();
    }

    /// Releases accumulated surplus to the current claim owner.
    ///
    /// Caller: Claim owner.
    /// Deposit: None. Forwards surplus value to owner_id; emits `surplus_released`.
    pub(crate) fn internal_release_surplus(&mut self, token_id: String) {
        let mut claim = self
            .claims
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("claim not found"));

        require!(
            env::predecessor_account_id() == claim.owner_id,
            "Unauthorized: owner only"
        );
        require!(claim.lock == Lock::None, "claim is locked");
        require!(claim.surplus.0 > 0, "no surplus to release");

        let amount = claim.surplus;
        let mut remaining = amount.0;
        let mut legs = Vec::new();

        // Allocate surplus across available balances in settlement assets
        for asset in &claim.settlement_assets {
            if remaining == 0 {
                break;
            }
            let avail = claim
                .last_seen_balance
                .get(asset)
                .copied()
                .unwrap_or(near_sdk::json_types::U128(0))
                .0;
            if avail > 0 {
                let take = std::cmp::min(remaining, avail);
                claim
                    .last_seen_balance
                    .insert(asset.clone(), near_sdk::json_types::U128(avail - take));
                remaining -= take;

                legs.push(crate::types::Leg::Pay {
                    receiver: claim.owner_id.clone(),
                    amount: near_sdk::json_types::U128(take),
                    asset: Some(asset.clone()),
                });
            }
        }

        require!(remaining == 0, "surplus not covered by last_seen balance");

        claim.surplus = near_sdk::json_types::U128(0);
        let prev_lock = claim.lock.clone();
        let current_block = env::block_height();
        claim.lock = Lock::Reconciling {
            since: current_block,
        };

        let claim_account = claim.claim_account.clone();
        self.claims.insert(token_id.clone(), claim);

        self.dispatch_distribution_forwards(
            &token_id,
            claim_account,
            legs,
            prev_lock,
            current_block,
            false,
            false,
            true,
        );
    }
}
