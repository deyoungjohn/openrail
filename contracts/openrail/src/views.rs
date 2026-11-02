//! View functions for Openrail contract state (Blueprint 2.1, 2.2).

use crate::claims::{compute_outstanding, format_token_id};
use crate::types::{ClaimView, Config, Quote};
use crate::Contract;
use near_sdk::json_types::U128;
use near_sdk::AccountId;

impl Contract {
    /// Returns the full Claim record along with undistributed legs by `token_id`.
    pub(crate) fn internal_claim(&self, token_id: &str) -> Option<ClaimView> {
        let claim = self.claims.get(token_id)?;
        let undistributed = self
            .undistributed
            .get(token_id)
            .cloned()
            .unwrap_or_default();
        Some(ClaimView::from_claim(claim.clone(), undistributed))
    }

    /// Returns claims issued by the given account, paginated.
    pub(crate) fn internal_claims_by_issuer(
        &self,
        account: AccountId,
        from: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<ClaimView> {
        let start = from.unwrap_or(1);
        let max_results = limit.unwrap_or(50) as usize;
        let mut results = Vec::new();

        for n in start..self.next_token_id {
            let token_id = format_token_id(n);
            if let Some(claim) = self.claims.get(&token_id) {
                if claim.issuer_id == account {
                    let undistributed = self
                        .undistributed
                        .get(&token_id)
                        .cloned()
                        .unwrap_or_default();
                    results.push(ClaimView::from_claim(claim.clone(), undistributed));
                    if results.len() >= max_results {
                        break;
                    }
                }
            }
        }
        results
    }

    /// Returns outstanding amount due on the claim in USDC base units.
    pub(crate) fn internal_outstanding(&self, token_id: &str) -> Option<U128> {
        let claim = self.claims.get(token_id)?;
        Some(U128(compute_outstanding(claim)))
    }

    /// Returns payment log quotes for the given claim, paginated.
    pub(crate) fn internal_payment_log(
        &self,
        token_id: &str,
        from: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<Quote> {
        let total = self.payment_log_count.get(token_id).copied().unwrap_or(0);
        let start = from.unwrap_or(0);
        let max_results = limit.unwrap_or(50);
        let end = std::cmp::min(start.saturating_add(max_results), total);

        let mut quotes = Vec::new();
        for idx in start..end {
            if let Some(q) = self.payment_log.get(&(token_id.to_string(), idx)) {
                quotes.push(q.clone());
            }
        }
        quotes
    }

    /// Returns global contract configuration.
    pub(crate) fn internal_config(&self) -> Config {
        self.config.clone()
    }
}
