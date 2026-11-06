//! Claim issuance, storage credits, and administration (Blueprint 2.1, 2.2).

use crate::claims::{
    format_claim_account, format_token_id, ACCOUNT_CREATION_TRANSFER, GAS_FOR_ON_ISSUE,
    REQUIRED_ISSUE_DEPOSIT,
};
use crate::events::{
    ConfigChangedEvent, IssueEvent, NftMintEvent, QuoteLoggedEvent, StorageSponsoredEvent,
};
use crate::types::{
    Claim, Debtor, Hex32, Lock, Quote, SponsorStatusView, Status, TokenId, TokenMetadata,
};
use crate::Contract;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, NearToken};
use std::collections::HashMap;

/// Callback payload passed to `on_issue`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct IssueCallbackArgs {
    pub token_id: String,
    pub is_issue_for: bool,
    pub payer_or_business: AccountId,
    pub attached_deposit: U128,
    pub storage_cost: U128,
    #[serde(default)]
    pub is_sponsored: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OnIssueArgs {
    pub args: IssueCallbackArgs,
}

fn build_token_metadata(
    n: u64,
    amount_due: u128,
    due_date: u64,
    terms_hash: Hex32,
    metadata: Option<TokenMetadata>,
) -> TokenMetadata {
    let default_title = format!("Invoice {n}");
    let default_desc = format!(
        "{} due {}",
        crate::svg::format_amount(amount_due),
        crate::svg::format_date(due_date)
    );
    match metadata {
        Some(mut m) => {
            if m.title.is_none() {
                m.title = Some(default_title);
            }
            if m.description.is_none() {
                m.description = Some(default_desc);
            }
            if m.extra.is_none() {
                m.extra = Some(terms_hash.to_string());
            }
            m
        }
        None => TokenMetadata {
            title: Some(default_title),
            description: Some(default_desc),
            media: None,
            media_hash: None,
            copies: Some(1),
            issued_at: Some(env::block_timestamp_ms()),
            expires_at: Some(due_date.saturating_mul(1000)),
            starts_at: None,
            updated_at: None,
            extra: Some(terms_hash.to_string()),
            reference: None,
            reference_hash: None,
        },
    }
}

impl Contract {
    /// Issues a new claim and initiates keyless vault sub-account creation.
    pub(crate) fn internal_issue(
        &mut self,
        kind: u8,
        debtor: Option<Debtor>,
        terms_hash: Hex32,
        amount_due: U128,
        due_date: u64,
        metadata: Option<TokenMetadata>,
    ) -> String {
        require!(!self.config.issue_paused, "issuance is paused");
        require!(
            self.config.vault_code_hash.0 != [0u8; 32],
            "vault not configured"
        );
        require!(amount_due.0 > 0, "amount_due must be positive");

        let kind_rules = crate::hooks::dispatch_kind_rules(kind);
        if debtor.is_none() {
            require!(kind_rules.debtor_optional, "debtor required");
        }

        let attached = env::attached_deposit();
        require!(attached >= REQUIRED_ISSUE_DEPOSIT, "deposit too low");

        let n = self.next_token_id;
        self.next_token_id += 1;
        let token_id = format_token_id(n);
        let claim_account = format_claim_account(&token_id, &env::current_account_id());
        let caller = env::predecessor_account_id();

        let final_metadata = build_token_metadata(n, amount_due.0, due_date, terms_hash, metadata);

        let claim = Claim {
            token_id: token_id.clone(),
            kind,
            issuer_id: caller.clone(),
            owner_id: caller.clone(),
            claim_account: claim_account.clone(),
            debtor,
            terms_hash,
            amount_due,
            due_date,
            ack: None,
            status: Status::Issued,
            lock: Lock::None,
            settlement_assets: self.config.settlement_assets.clone(),
            booked_total: U128(0),
            distributed_total: U128(0),
            fee_total: U128(0),
            surplus: U128(0),
            credit_total: U128(0),
            credit_source: None,
            last_seen_balance: HashMap::new(),
            assignment_doc_hash: None,
            created_block: env::block_height(),
        };

        self.claims.insert(token_id.clone(), claim);
        self.token_metadata.insert(token_id.clone(), final_metadata);

        let batch = env::promise_batch_create(&claim_account);
        env::promise_batch_action_create_account(batch);
        env::promise_batch_action_transfer(batch, ACCOUNT_CREATION_TRANSFER);
        env::promise_batch_action_use_global_contract(batch, &self.config.vault_code_hash.0);

        let args = IssueCallbackArgs {
            token_id: token_id.clone(),
            is_issue_for: false,
            payer_or_business: caller,
            attached_deposit: U128(attached.as_yoctonear()),
            storage_cost: U128(REQUIRED_ISSUE_DEPOSIT.as_yoctonear()),
            is_sponsored: false,
        };
        let args_bytes =
            near_sdk::serde_json::to_vec(&OnIssueArgs { args }).expect("failed to serialize args");
        let callback = env::promise_then(
            batch,
            env::current_account_id(),
            "on_issue",
            &args_bytes,
            NearToken::ZERO,
            GAS_FOR_ON_ISSUE,
        );
        env::promise_return(callback);
        token_id
    }

    /// Issues a new claim on behalf of a registered business using prepaid storage credit.
    pub(crate) fn internal_issue_for(
        &mut self,
        business: AccountId,
        kind: u8,
        debtor: Option<Debtor>,
        terms_hash: Hex32,
        amount_due: U128,
        due_date: u64,
        metadata: Option<TokenMetadata>,
    ) -> String {
        require!(
            self.config.issuers.contains(&env::predecessor_account_id()),
            "Unauthorized issuer"
        );
        require!(!self.config.issue_paused, "issuance is paused");
        require!(
            self.config.vault_code_hash.0 != [0u8; 32],
            "vault not configured"
        );
        require!(amount_due.0 > 0, "amount_due must be positive");

        let kind_rules = crate::hooks::dispatch_kind_rules(kind);
        if debtor.is_none() {
            require!(kind_rules.debtor_optional, "debtor required");
        }

        let current_credit = self
            .storage_credit
            .get(&business)
            .copied()
            .unwrap_or(U128(0))
            .0;

        let required = REQUIRED_ISSUE_DEPOSIT.as_yoctonear();
        let is_sponsored = if current_credit >= required {
            let rem = current_credit - required;
            if rem == 0 {
                self.storage_credit.remove(&business);
            } else {
                self.storage_credit.insert(business.clone(), U128(rem));
            }
            false
        } else {
            let used = self.sponsored_count.get(&business).copied().unwrap_or(0);
            if self.sponsor_pool.0 >= required && used < self.sponsor_cap {
                self.sponsor_pool = U128(self.sponsor_pool.0 - required);
                self.sponsored_count.insert(business.clone(), used + 1);
                StorageSponsoredEvent {
                    business: business.clone(),
                    amount: U128(required),
                }
                .emit();
                true
            } else {
                env::panic_str("NO_STORAGE_CREDIT");
            }
        };

        let n = self.next_token_id;
        self.next_token_id += 1;
        let token_id = format_token_id(n);
        let claim_account = format_claim_account(&token_id, &env::current_account_id());

        let final_metadata = build_token_metadata(n, amount_due.0, due_date, terms_hash, metadata);

        let claim = Claim {
            token_id: token_id.clone(),
            kind,
            issuer_id: business.clone(),
            owner_id: business.clone(),
            claim_account: claim_account.clone(),
            debtor,
            terms_hash,
            amount_due,
            due_date,
            ack: None,
            status: Status::Issued,
            lock: Lock::None,
            settlement_assets: self.config.settlement_assets.clone(),
            booked_total: U128(0),
            distributed_total: U128(0),
            fee_total: U128(0),
            surplus: U128(0),
            credit_total: U128(0),
            credit_source: None,
            last_seen_balance: HashMap::new(),
            assignment_doc_hash: None,
            created_block: env::block_height(),
        };

        self.claims.insert(token_id.clone(), claim);
        self.token_metadata.insert(token_id.clone(), final_metadata);

        let batch = env::promise_batch_create(&claim_account);
        env::promise_batch_action_create_account(batch);
        env::promise_batch_action_transfer(batch, ACCOUNT_CREATION_TRANSFER);
        env::promise_batch_action_use_global_contract(batch, &self.config.vault_code_hash.0);

        let args = IssueCallbackArgs {
            token_id: token_id.clone(),
            is_issue_for: true,
            payer_or_business: business,
            attached_deposit: U128(0),
            storage_cost: U128(required),
            is_sponsored,
        };
        let args_bytes =
            near_sdk::serde_json::to_vec(&OnIssueArgs { args }).expect("failed to serialize args");
        let callback = env::promise_then(
            batch,
            env::current_account_id(),
            "on_issue",
            &args_bytes,
            NearToken::ZERO,
            GAS_FOR_ON_ISSUE,
        );
        env::promise_return(callback);
        token_id
    }

    /// Handles callback from keyless claim account creation.
    pub(crate) fn internal_on_issue(&mut self, args: IssueCallbackArgs) -> Option<String> {
        let success = env::promise_result_checked(0, 1024).is_ok();

        if success {
            let claim = self
                .claims
                .get(&args.token_id)
                .cloned()
                .expect("claim must exist in state");
            self.internal_add_global_token(&args.token_id);
            self.internal_add_owner_token(&claim.owner_id, &args.token_id);

            NftMintEvent {
                owner_id: claim.owner_id.clone(),
                token_ids: vec![args.token_id.clone()],
                memo: None,
            }
            .emit();

            IssueEvent {
                token_id: args.token_id.clone(),
                kind: claim.kind,
                issuer_id: claim.issuer_id.clone(),
                owner_id: claim.owner_id.clone(),
                debtor: claim.debtor.clone(),
                terms_hash: claim.terms_hash,
                amount_due: claim.amount_due,
                due_date: claim.due_date,
            }
            .emit();

            if !args.is_issue_for && args.attached_deposit.0 > args.storage_cost.0 {
                let excess = args.attached_deposit.0 - args.storage_cost.0;
                let refund = env::promise_batch_create(&args.payer_or_business);
                env::promise_batch_action_transfer(refund, NearToken::from_yoctonear(excess));
            }

            Some(args.token_id)
        } else {
            self.claims.remove(&args.token_id);
            self.token_metadata.remove(&args.token_id);

            if args.is_issue_for {
                if args.is_sponsored {
                    self.sponsor_pool =
                        U128(self.sponsor_pool.0.saturating_add(args.storage_cost.0));
                    let cur_used = self
                        .sponsored_count
                        .get(&args.payer_or_business)
                        .copied()
                        .unwrap_or(0);
                    if cur_used <= 1 {
                        self.sponsored_count.remove(&args.payer_or_business);
                    } else {
                        self.sponsored_count
                            .insert(args.payer_or_business, cur_used - 1);
                    }
                } else {
                    let cur = self
                        .storage_credit
                        .get(&args.payer_or_business)
                        .copied()
                        .unwrap_or(U128(0))
                        .0;
                    self.storage_credit
                        .insert(args.payer_or_business, U128(cur + args.storage_cost.0));
                }
            } else if args.attached_deposit.0 > 0 {
                let refund = env::promise_batch_create(&args.payer_or_business);
                env::promise_batch_action_transfer(
                    refund,
                    NearToken::from_yoctonear(args.attached_deposit.0),
                );
            }

            None
        }
    }

    /// Deposits NEAR for storage credit.
    pub(crate) fn internal_deposit_storage_credit(&mut self) {
        let deposit = env::attached_deposit();
        require!(deposit.as_yoctonear() > 0, "deposit must be positive");
        let caller = env::predecessor_account_id();
        let cur = self
            .storage_credit
            .get(&caller)
            .copied()
            .unwrap_or(U128(0))
            .0;
        self.storage_credit
            .insert(caller, U128(cur + deposit.as_yoctonear()));
    }

    /// Withdraws unused storage credit.
    pub(crate) fn internal_withdraw_storage_credit(&mut self, amount: U128) {
        let caller = env::predecessor_account_id();
        let cur = self
            .storage_credit
            .get(&caller)
            .copied()
            .unwrap_or(U128(0))
            .0;
        require!(cur >= amount.0, "insufficient storage credit");
        let rem = cur - amount.0;
        if rem == 0 {
            self.storage_credit.remove(&caller);
        } else {
            self.storage_credit.insert(caller.clone(), U128(rem));
        }

        let refund = env::promise_batch_create(&caller);
        env::promise_batch_action_transfer(refund, NearToken::from_yoctonear(amount.0));
        env::promise_return(refund);
    }

    /// Deposits attached NEAR into the storage-credit sponsor pool (Blueprint REL-1, Card A10).
    pub(crate) fn internal_deposit_sponsor_pool(&mut self) {
        let deposit = env::attached_deposit();
        require!(deposit.as_yoctonear() > 0, "deposit must be positive");
        self.sponsor_pool = U128(
            self.sponsor_pool
                .0
                .checked_add(deposit.as_yoctonear())
                .expect("pool overflow"),
        );
    }

    /// Withdraws NEAR from the storage-credit sponsor pool (Blueprint REL-1, Card A10).
    pub(crate) fn internal_withdraw_sponsor_pool(&mut self, amount: U128) {
        self.assert_root_only();
        require!(
            amount.0 <= self.sponsor_pool.0,
            "insufficient sponsor pool balance"
        );
        self.sponsor_pool = U128(self.sponsor_pool.0 - amount.0);
        let caller = env::predecessor_account_id();
        let refund = env::promise_batch_create(&caller);
        env::promise_batch_action_transfer(refund, NearToken::from_yoctonear(amount.0));
        env::promise_return(refund);
    }

    /// Sets the per-business sponsor cap (Blueprint REL-1, Card A10).
    pub(crate) fn internal_set_sponsor_cap(&mut self, cap: u64) {
        self.assert_root_only();
        self.sponsor_cap = cap;
    }

    /// Returns storage-credit sponsorship status for an account (Blueprint REL-1, Card A10).
    pub(crate) fn internal_sponsor_status(&self, account_id: AccountId) -> SponsorStatusView {
        let used = self.sponsored_count.get(&account_id).copied().unwrap_or(0);
        SponsorStatusView {
            pool: self.sponsor_pool,
            cap: self.sponsor_cap,
            used,
        }
    }

    /// Appends a Quote log entry before deposit address is shown.
    pub(crate) fn internal_log_quote(&mut self, token_id: String, quote: Quote) {
        require!(
            self.config
                .quote_writers
                .contains(&env::predecessor_account_id()),
            "Unauthorized quote writer"
        );
        require!(self.claims.contains_key(&token_id), "claim not found");

        let dedup_key = (token_id.clone(), quote.quote_id.clone());
        require!(
            !self.quote_dedup.contains_key(&dedup_key),
            "duplicate quote_id"
        );
        self.quote_dedup.insert(dedup_key, ());

        let count = self.payment_log_count.get(&token_id).copied().unwrap_or(0);
        self.payment_log
            .insert((token_id.clone(), count), quote.clone());
        self.payment_log_count.insert(token_id.clone(), count + 1);

        QuoteLoggedEvent {
            token_id,
            quote_id: quote.quote_id,
            deposit_address: quote.deposit_address,
            deadline_requested: quote.deadline_requested,
            refund_to: quote.refund_to,
            route_id: quote.route_id,
        }
        .emit();
    }

    /// Updates contract admin configuration.
    pub(crate) fn internal_set_config(
        &mut self,
        settlement_assets: Option<Vec<TokenId>>,
        vault_code_hash: Option<Hex32>,
        fee_account: Option<AccountId>,
        issue_paused: Option<bool>,
        watchers: Option<Vec<AccountId>>,
        quote_writers: Option<Vec<AccountId>>,
        issuers: Option<Vec<AccountId>>,
    ) {
        self.assert_root_only();

        if let Some(val) = settlement_assets {
            self.config.settlement_assets = val.clone();
            ConfigChangedEvent {
                parameter: "settlement_assets".to_string(),
                new_value: format!("{:?}", val),
            }
            .emit();
        }
        if let Some(val) = vault_code_hash {
            self.config.vault_code_hash = val;
            ConfigChangedEvent {
                parameter: "vault_code_hash".to_string(),
                new_value: val.to_string(),
            }
            .emit();
        }
        if let Some(val) = fee_account {
            self.config.fee_account = val.clone();
            ConfigChangedEvent {
                parameter: "fee_account".to_string(),
                new_value: val.to_string(),
            }
            .emit();
        }
        if let Some(val) = issue_paused {
            self.config.issue_paused = val;
            ConfigChangedEvent {
                parameter: "issue_paused".to_string(),
                new_value: val.to_string(),
            }
            .emit();
        }
        if let Some(val) = watchers {
            self.config.watchers = val.clone();
            ConfigChangedEvent {
                parameter: "watchers".to_string(),
                new_value: format!("{:?}", val),
            }
            .emit();
        }
        if let Some(val) = quote_writers {
            self.config.quote_writers = val.clone();
            ConfigChangedEvent {
                parameter: "quote_writers".to_string(),
                new_value: format!("{:?}", val),
            }
            .emit();
        }
        if let Some(val) = issuers {
            self.config.issuers = val.clone();
            ConfigChangedEvent {
                parameter: "issuers".to_string(),
                new_value: format!("{:?}", val),
            }
            .emit();
        }
    }

    /// Pauses or unpauses claim issuance.
    pub(crate) fn internal_pause_issue(&mut self, paused: bool) {
        self.assert_root_only();
        self.config.issue_paused = paused;
        ConfigChangedEvent {
            parameter: "issue_paused".to_string(),
            new_value: paused.to_string(),
        }
        .emit();
    }
}
