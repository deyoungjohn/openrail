//! Helper functions on `Env` for common test operations.

use anyhow::{Context, Result};
use near_sdk::json_types::U128;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use openrail::types::{Debtor, Hex32, TokenMetadata};
use serde_json::{json, Value};

use crate::env::Env;
use crate::gas::GasReport;

pub const DEFAULT_SETTLEMENT_ASSET: &str =
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

impl Env {
    /// Issues a new claim on behalf of `caller` on the root contract.
    ///
    /// Attached deposit is 0.05 NEAR to cover storage staking.
    pub async fn issue_claim(
        &self,
        caller: &Account,
        kind: u8,
        amount_due: u128,
        due_date: u64,
    ) -> Result<ExecutionFinalResult> {
        self.issue_claim_with_details(
            caller,
            kind,
            Some(Debtor::Near(caller.id().clone())),
            Hex32::new([0u8; 32]),
            amount_due,
            due_date,
            None,
        )
        .await
    }

    /// Full-parameter `issue` call helper.
    #[allow(clippy::too_many_arguments)]
    pub async fn issue_claim_with_details(
        &self,
        caller: &Account,
        kind: u8,
        debtor: Option<Debtor>,
        terms_hash: Hex32,
        amount_due: u128,
        due_date: u64,
        metadata: Option<TokenMetadata>,
    ) -> Result<ExecutionFinalResult> {
        let res = caller
            .call(self.root.id(), "issue")
            .args_json(json!({
                "kind": kind,
                "debtor": debtor,
                "terms_hash": terms_hash,
                "amount_due": U128(amount_due),
                "due_date": due_date,
                "metadata": metadata,
            }))
            .deposit(NearToken::from_millinear(50))
            .max_gas()
            .transact()
            .await
            .context("transact issue")?;

        Ok(res)
    }

    /// Funds a claim by minting tokens on `intents.near` to its dedicated keyless vault sub-account.
    ///
    /// The recipient account ID is `{token_id}.{root_id}` (e.g. `c-1.openrail.near`).
    /// Balances of non-existent accounts are readable and creditable (Blueprint 1.5.9).
    pub async fn fund_claim(
        &self,
        token_id: &str,
        amount: u128,
        asset: Option<&str>,
    ) -> Result<ExecutionFinalResult> {
        let claim_account_id = format!("{token_id}.{}", self.root.id());
        let asset_id = asset.unwrap_or(DEFAULT_SETTLEMENT_ASSET);

        let res = self
            .parent
            .call(self.intents.id(), "mt_mint")
            .args_json(json!({
                "account_id": claim_account_id,
                "token_id": asset_id,
                "amount": U128(amount),
            }))
            .max_gas()
            .transact()
            .await
            .context("transact mt_mint")?;

        Ok(res)
    }

    /// Burns tokens from a claim's vault on `intents.near` (simulating balance drop / anomaly).
    pub async fn burn_claim_balance(
        &self,
        token_id: &str,
        amount: u128,
        asset: Option<&str>,
    ) -> Result<ExecutionFinalResult> {
        let claim_account_id = format!("{token_id}.{}", self.root.id());
        let asset_id = asset.unwrap_or(DEFAULT_SETTLEMENT_ASSET);

        let res = self
            .parent
            .call(self.intents.id(), "mt_burn")
            .args_json(json!({
                "account_id": claim_account_id,
                "token_id": asset_id,
                "amount": U128(amount),
            }))
            .max_gas()
            .transact()
            .await
            .context("transact mt_burn")?;

        Ok(res)
    }

    /// Views the multi-token balance for a claim's vault account on `intents.near`.
    pub async fn claim_balance(&self, token_id: &str, asset: Option<&str>) -> Result<u128> {
        let claim_account_id = format!("{token_id}.{}", self.root.id());
        let asset_id = asset.unwrap_or(DEFAULT_SETTLEMENT_ASSET);

        let bal: U128 = self
            .intents
            .view("mt_balance_of")
            .args_json(json!({
                "account_id": claim_account_id,
                "token_id": asset_id,
            }))
            .await?
            .json()?;

        Ok(bal.0)
    }

    /// Advances the sandbox blockchain height by `n` blocks.
    pub async fn advance_blocks(&self, n: u64) -> Result<()> {
        self.worker
            .fast_forward(n)
            .await
            .with_context(|| format!("fast forward {n} blocks"))
    }

    /// Returns a fluent helper for making calls as `account`.
    pub fn call_as<'a>(&'a self, account: &'a Account) -> Caller<'a> {
        Caller { env: self, account }
    }

    /// Decodes all NEP-297 events emitted in `res`.
    pub fn decode_events(&self, res: &ExecutionFinalResult) -> Vec<Value> {
        crate::events::decode_events(res)
    }

    /// Asserts that `event_name` was emitted and conforms to its JSON schema.
    pub fn assert_event(&self, res: &ExecutionFinalResult, event_name: &str) -> Vec<Value> {
        crate::events::assert_event_emitted(res, event_name)
    }

    /// Formats and returns a gas summary report for `res`.
    pub fn gas_report(&self, res: &ExecutionFinalResult) -> GasReport {
        GasReport::from_result(res)
    }
}

/// Helper struct for fluent calls executed by a specific account.
pub struct Caller<'a> {
    pub env: &'a Env,
    pub account: &'a Account,
}

impl<'a> Caller<'a> {
    /// Calls a method on the root contract (`openrail.near`).
    pub async fn call_root(
        &self,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> Result<ExecutionFinalResult> {
        self.call_contract(&self.env.root, method, args, deposit)
            .await
    }

    /// Calls a method on an arbitrary contract.
    pub async fn call_contract(
        &self,
        contract: &Contract,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> Result<ExecutionFinalResult> {
        let res = self
            .account
            .call(contract.id(), method)
            .args_json(args)
            .deposit(deposit)
            .max_gas()
            .transact()
            .await
            .with_context(|| format!("call {}::{}", contract.id(), method))?;
        Ok(res)
    }
}
