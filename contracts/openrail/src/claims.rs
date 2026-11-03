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

impl Contract {
    /// Asserts that the caller is the contract itself (`<root>`).
    pub(crate) fn assert_root_only(&self) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Unauthorized: root only"
        );
    }

    /// Adds a token ID to the owner's index list.
    #[allow(dead_code)]
    pub(crate) fn internal_add_owner_token(&mut self, owner: &AccountId, token_id: &str) {
        let mut tokens = self.owner_index.get(owner).cloned().unwrap_or_default();
        if !tokens.iter().any(|t| t == token_id) {
            tokens.push(token_id.to_string());
            self.owner_index.insert(owner.clone(), tokens);
        }
    }

    /// Removes a token ID from the owner's index list.
    #[allow(dead_code)]
    pub(crate) fn internal_remove_owner_token(&mut self, owner: &AccountId, token_id: &str) {
        if let Some(mut tokens) = self.owner_index.get(owner).cloned() {
            if let Some(pos) = tokens.iter().position(|t| t == token_id) {
                tokens.swap_remove(pos);
                if tokens.is_empty() {
                    self.owner_index.remove(owner);
                } else {
                    self.owner_index.insert(owner.clone(), tokens);
                }
            }
        }
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
