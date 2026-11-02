//! Gas reporting utilities for sandbox execution results.

use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};

/// Summary of gas and tokens burnt by a transaction and its spawned receipts.
#[derive(Clone, Debug)]
pub struct GasReport {
    /// Total gas burnt in Tgas (1 Tgas = 10^12 gas).
    pub total_tgas: f64,
    /// Total gas burnt as raw `Gas`.
    pub total_gas: Gas,
    /// Total tokens burnt as fees.
    pub tokens_burnt: NearToken,
    /// Count of receipt outcomes executed.
    pub receipts_count: usize,
}

impl GasReport {
    /// Extracts a gas report from a workspace execution result.
    pub fn from_result(res: &ExecutionFinalResult) -> Self {
        let total_gas = res.total_gas_burnt;
        let total_tgas = total_gas.as_gas() as f64 / 1_000_000_000_000.0;
        let total_tokens_yocto: u128 = res
            .outcomes()
            .iter()
            .map(|o| o.tokens_burnt.as_yoctonear())
            .sum();
        let tokens_burnt = NearToken::from_yoctonear(total_tokens_yocto);
        let receipts_count = res.receipt_outcomes().len();

        Self {
            total_tgas,
            total_gas,
            tokens_burnt,
            receipts_count,
        }
    }

    /// Printable one-line summary.
    pub fn summary(&self) -> String {
        format!(
            "Gas burnt: {:.3} Tgas ({} yoctoNEAR, {} receipts)",
            self.total_tgas,
            self.tokens_burnt.as_yoctonear(),
            self.receipts_count
        )
    }
}
