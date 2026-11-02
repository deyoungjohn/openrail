//! Claims state management and domain invariants (Blueprint 2.1, 2.3).

use crate::types::Claim;
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
}
