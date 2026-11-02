//! State machine model implementing the reference protocol behavior (Blueprint 2.1–2.5).

use crate::actions::{Action, Event, ModelError};
use crate::hook::{CoreDefaultHook, Hook};
use crate::types::{
    AccountId, Ack, AckScheme, Claim, Config, Debtor, Hex32, KindRules, Leg, Lock, Quote, Status,
    TokenId,
};
use std::collections::HashMap;

/// Deliberate mutations configuration for testing invariant checkers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mutations {
    /// Mutant 1: calculates protocol fee with wrong bps (e.g. 20 bps instead of 25 bps).
    pub wrong_fee_rate: bool,
    /// Mutant 2: unbooks payments on failed distribution legs (violates D-S8).
    pub unbook_on_failed_distribution: bool,
    /// Mutant 3: transfer rewrites recipient of undistributed legs (violates D-S8).
    pub transfer_updates_undistributed_payee: bool,
    /// Mutant 4: counters allowed to decrease.
    pub allow_counter_decrement: bool,
    /// Mutant 5: breaks conservation arithmetic by dropping fee or surplus.
    pub broken_conservation: bool,
}

/// The reference protocol model.
pub struct Model {
    pub config: Config,
    pub claims: HashMap<String, Claim>,
    pub storage_credit: HashMap<AccountId, u128>,
    pub payment_log: HashMap<String, Vec<Quote>>,
    /// External Intents token balances for claim sub-accounts `(token_id, asset) -> balance`.
    pub intents_balances: HashMap<(String, TokenId), u128>,
    pub released_surplus: HashMap<String, u128>,
    pub pending_reconciles: HashMap<String, Lock>,
    pub hook: Box<dyn Hook>,
    pub mutations: Mutations,
}

impl Model {
    /// Creates a new default model with standard config and core default hooks.
    pub fn new() -> Self {
        Self::with_config_and_hook(Config::default(), Box::new(CoreDefaultHook))
    }

    /// Creates a model with specified config and custom hook.
    pub fn with_config_and_hook(config: Config, hook: Box<dyn Hook>) -> Self {
        Self {
            config,
            claims: HashMap::new(),
            storage_credit: HashMap::new(),
            payment_log: HashMap::new(),
            intents_balances: HashMap::new(),
            released_surplus: HashMap::new(),
            pending_reconciles: HashMap::new(),
            hook,
            mutations: Mutations::default(),
        }
    }

    /// Creates a model with active deliberate mutations (for mutation checks).
    pub fn with_mutations(mutations: Mutations) -> Self {
        let mut model = Self::new();
        model.mutations = mutations;
        model
    }

    /// Look up kind rules, falling back to standard invoice rules if kind == 0.
    pub fn get_kind_rules(&self, kind: u8) -> Result<KindRules, ModelError> {
        self.hook
            .kind_rules(kind)
            .ok_or(ModelError::UnknownKind(kind))
    }

    /// Retrieve an existing claim by token_id or return ModelError.
    pub fn get_claim(&self, token_id: &str) -> Result<&Claim, ModelError> {
        self.claims
            .get(token_id)
            .ok_or_else(|| ModelError::ClaimNotFound(token_id.to_string()))
    }

    /// Retrieve total surplus released to owner for a token.
    pub fn released_surplus(&self, token_id: &str) -> u128 {
        self.released_surplus.get(token_id).copied().unwrap_or(0)
    }

    /// Step the model state forward by executing an action at block height `block`.
    pub fn step(&mut self, action: Action, block: u64) -> Result<Vec<Event>, ModelError> {
        match action {
            Action::Issue {
                token_id,
                kind,
                issuer_id,
                debtor,
                terms_hash,
                amount_due,
                due_date,
            } => self.step_issue(
                token_id,
                kind,
                issuer_id.clone(),
                issuer_id,
                debtor,
                terms_hash,
                amount_due,
                due_date,
                block,
            ),

            Action::IssueFor {
                caller,
                business,
                token_id,
                kind,
                debtor,
                terms_hash,
                amount_due,
                due_date,
            } => {
                if !self.config.issuers.contains(&caller) {
                    return Err(ModelError::Unauthorized(
                        "caller is not an authorized issuer".into(),
                    ));
                }
                let credit = self
                    .storage_credit
                    .get_mut(&business)
                    .ok_or(ModelError::NoStorageCredit)?;
                if *credit < 1 {
                    return Err(ModelError::NoStorageCredit);
                }
                *credit -= 1;

                self.step_issue(
                    token_id,
                    kind,
                    business.clone(),
                    business,
                    debtor,
                    terms_hash,
                    amount_due,
                    due_date,
                    block,
                )
            }

            Action::DepositStorageCredit { business, amount } => {
                *self.storage_credit.entry(business).or_default() += amount;
                Ok(Vec::new())
            }

            Action::WithdrawStorageCredit { business, amount } => {
                let credit = self.storage_credit.entry(business).or_default();
                if *credit < amount {
                    return Err(ModelError::InvalidAmount(
                        "insufficient storage credit".into(),
                    ));
                }
                *credit -= amount;
                Ok(Vec::new())
            }

            Action::AcknowledgeNear { token_id, caller } => {
                let claim = self
                    .claims
                    .get_mut(&token_id)
                    .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;
                if claim.ack.is_some() {
                    return Err(ModelError::AlreadyAcknowledged);
                }
                match &claim.debtor {
                    Some(Debtor::Near(acc)) if acc == &caller => {}
                    _ => return Err(ModelError::InvalidSigner),
                }
                let scheme = AckScheme::Near {
                    account: caller.clone(),
                };
                claim.ack = Some(Ack {
                    scheme: scheme.clone(),
                    block,
                });
                Ok(vec![Event::Ack { token_id, scheme }])
            }

            Action::AcknowledgeEvm {
                token_id,
                chain_id,
                signer,
            } => {
                let claim = self
                    .claims
                    .get_mut(&token_id)
                    .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;
                if claim.ack.is_some() {
                    return Err(ModelError::AlreadyAcknowledged);
                }
                match &claim.debtor {
                    Some(Debtor::Evm(addr)) if addr == &signer => {}
                    _ => return Err(ModelError::InvalidSigner),
                }
                let scheme = AckScheme::Evm { chain_id, signer };
                claim.ack = Some(Ack {
                    scheme: scheme.clone(),
                    block,
                });
                Ok(vec![Event::Ack { token_id, scheme }])
            }

            Action::DepositIntentsBalance {
                token_id,
                asset,
                amount,
            } => {
                if !self.claims.contains_key(&token_id) {
                    return Err(ModelError::ClaimNotFound(token_id));
                }
                *self.intents_balances.entry((token_id, asset)).or_default() += amount;
                Ok(Vec::new())
            }

            Action::DrainIntentsBalance {
                token_id,
                asset,
                amount,
            } => {
                if !self.claims.contains_key(&token_id) {
                    return Err(ModelError::ClaimNotFound(token_id));
                }
                if let Some(bal) = self.intents_balances.get_mut(&(token_id, asset)) {
                    *bal = bal.saturating_sub(amount);
                }
                Ok(Vec::new())
            }

            Action::LogQuote {
                caller,
                token_id,
                quote,
            } => {
                if !self.config.quote_writers.contains(&caller) {
                    return Err(ModelError::Unauthorized(
                        "caller is not an authorized quote writer".into(),
                    ));
                }
                if !self.claims.contains_key(&token_id) {
                    return Err(ModelError::ClaimNotFound(token_id));
                }
                let quotes = self.payment_log.entry(token_id.clone()).or_default();
                if quotes.iter().any(|q| q.quote_id == quote.quote_id) {
                    return Err(ModelError::DuplicateQuote(quote.quote_id));
                }
                let quote_id = quote.quote_id.clone();
                quotes.push(quote);
                Ok(vec![Event::QuoteLogged { token_id, quote_id }])
            }

            Action::PrepareTransfer { caller, token_id } => {
                let claim = self
                    .claims
                    .get_mut(&token_id)
                    .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;
                if claim.owner_id != caller {
                    return Err(ModelError::Unauthorized(
                        "only owner can prepare transfer".into(),
                    ));
                }
                if !claim.lock.allows_transfer() {
                    return Err(ModelError::ClaimLocked(
                        "cannot prepare transfer under lock".into(),
                    ));
                }
                self.hook
                    .check_transfer(claim, &caller)
                    .map_err(ModelError::HookRefusal)?;

                let until = block + 1800;
                claim.lock = Lock::TransferWindow { until };
                Ok(vec![Event::TransferWindow { token_id, until }])
            }

            Action::Transfer {
                caller,
                token_id,
                new_owner,
                memo_assignment_doc_hash,
                attached_yocto,
            } => {
                let kind = {
                    let claim = self
                        .claims
                        .get(&token_id)
                        .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;
                    claim.kind
                };
                let kind_rules = self.get_kind_rules(kind)?;

                let claim = self
                    .claims
                    .get_mut(&token_id)
                    .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;

                if claim.owner_id != caller {
                    return Err(ModelError::Unauthorized("only owner can transfer".into()));
                }

                // Rule 1: lock in {None, TransferWindow}
                if !claim.lock.allows_transfer() {
                    return Err(ModelError::TransferRuleViolation(
                        1,
                        "lock must be None or TransferWindow".into(),
                    ));
                }

                // Rule 2: status in {Issued, PartiallyPaid}
                if !matches!(claim.status, Status::Issued | Status::PartiallyPaid) {
                    return Err(ModelError::TransferRuleViolation(
                        2,
                        "status must be Issued or PartiallyPaid".into(),
                    ));
                }

                let is_sale = new_owner != claim.issuer_id;

                // Rule 3: ack required for sale
                if is_sale && kind_rules.ack_required_for_sale && claim.ack.is_none() {
                    return Err(ModelError::TransferRuleViolation(
                        3,
                        "unacknowledged claim cannot be sold".into(),
                    ));
                }

                // Rule 4: assignment doc hash required on sale
                if is_sale && memo_assignment_doc_hash.is_none() {
                    return Err(ModelError::TransferRuleViolation(
                        4,
                        "assignment document hash required on sale".into(),
                    ));
                }

                // Rule 5: receiver != claim_account
                if new_owner == claim.claim_account {
                    return Err(ModelError::TransferRuleViolation(
                        5,
                        "receiver cannot be claim account".into(),
                    ));
                }

                // Rule 6: attached yocto == 1
                if attached_yocto != 1 {
                    return Err(ModelError::TransferRuleViolation(
                        6,
                        "exactly 1 yocto must be attached".into(),
                    ));
                }

                // Rule 7: sellable
                if !kind_rules.sellable {
                    return Err(ModelError::TransferRuleViolation(
                        7,
                        "claim kind is not sellable".into(),
                    ));
                }

                // Rule 8: hook check
                self.hook
                    .check_transfer(claim, &new_owner)
                    .map_err(|e| ModelError::TransferRuleViolation(8, e))?;

                // Transfer execution
                let old_owner = claim.owner_id.clone();
                claim.owner_id = new_owner.clone();
                claim.lock = Lock::None; // transfer consumes window

                if is_sale {
                    claim.assignment_doc_hash = memo_assignment_doc_hash;
                }

                // Deliberate mutant 3: updates undistributed legs receiver
                if self.mutations.transfer_updates_undistributed_payee {
                    for leg in &mut claim.undistributed {
                        if let Leg::Pay { receiver, .. } = leg {
                            *receiver = new_owner.clone();
                        }
                    }
                }

                Ok(vec![Event::Transferred {
                    token_id,
                    old_owner,
                    new_owner,
                }])
            }

            Action::ReconcileStart { token_id } => self.step_reconcile_start(token_id, block),

            Action::ReconcileCallback {
                token_id,
                leg_failures,
                callback_ok,
            } => self.step_reconcile_callback(token_id, leg_failures, callback_ok, block),

            Action::Reconcile {
                token_id,
                leg_failures,
            } => self.step_reconcile(token_id, leg_failures, block),

            Action::RetryDistribution {
                token_id,
                leg_failures,
            } => self.step_retry_distribution(token_id, leg_failures),

            Action::ClearStaleLock { token_id } => {
                let claim = self
                    .claims
                    .get_mut(&token_id)
                    .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;
                match claim.lock {
                    Lock::Reconciling { since } => {
                        if block >= since + 100 {
                            claim.lock = Lock::None;
                            Ok(vec![Event::LockCleared { token_id }])
                        } else {
                            Err(ModelError::LockNotStale)
                        }
                    }
                    Lock::TransferWindow { until } => {
                        if block >= until {
                            claim.lock = Lock::None;
                            Ok(vec![Event::LockCleared { token_id }])
                        } else {
                            Err(ModelError::LockNotStale)
                        }
                    }
                    Lock::Module { until, .. } => {
                        if block >= until {
                            claim.lock = Lock::None;
                            Ok(vec![Event::LockCleared { token_id }])
                        } else {
                            Err(ModelError::LockNotStale)
                        }
                    }
                    Lock::None => Err(ModelError::NoLock),
                }
            }

            Action::Cancel {
                caller,
                token_id,
                debtor_cosig,
            } => {
                let claim = self
                    .claims
                    .get_mut(&token_id)
                    .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;
                if claim.owner_id != caller {
                    return Err(ModelError::Unauthorized("only owner can cancel".into()));
                }
                if claim.booked_total > 0 || claim.credit_total > 0 || !claim.lock.is_none() {
                    return Err(ModelError::CancelDisallowed);
                }
                self.hook
                    .check_cancel(claim)
                    .map_err(ModelError::HookRefusal)?;

                if claim.ack.is_some() {
                    match &claim.debtor {
                        Some(Debtor::Near(acc)) => {
                            if debtor_cosig != Some(crate::types::DebtorCosig::Near)
                                && &caller != acc
                            {
                                return Err(ModelError::CancelDebtorCosigRequired);
                            }
                        }
                        Some(Debtor::Evm(_))
                            if !matches!(
                                debtor_cosig,
                                Some(crate::types::DebtorCosig::Evm { .. })
                            ) =>
                        {
                            return Err(ModelError::CancelDebtorCosigRequired);
                        }
                        _ => {}
                    }
                }

                claim.status = Status::Cancelled;

                if self.mutations.allow_counter_decrement {
                    claim.booked_total = claim.booked_total.saturating_sub(1);
                }

                Ok(vec![Event::Cancel { token_id }])
            }

            Action::Close { caller, token_id } => {
                let claim = self
                    .claims
                    .get_mut(&token_id)
                    .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;
                if claim.owner_id != caller {
                    return Err(ModelError::Unauthorized("only owner can close".into()));
                }
                if claim.status != Status::Paid {
                    return Err(ModelError::CloseDisallowed("claim is not Paid".into()));
                }
                if claim.surplus > 0 {
                    return Err(ModelError::CloseDisallowed(
                        "claim has unreleased surplus".into(),
                    ));
                }
                if !claim.lock.is_none() {
                    return Err(ModelError::CloseDisallowed("claim is locked".into()));
                }

                claim.status = Status::Closed;
                Ok(vec![Event::Close { token_id }])
            }

            Action::CloseWriteoff { caller, token_id } => {
                let claim = self
                    .claims
                    .get_mut(&token_id)
                    .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;
                if claim.owner_id != caller {
                    return Err(ModelError::Unauthorized(
                        "only owner can close writeoff".into(),
                    ));
                }
                if claim.status != Status::PartiallyPaid {
                    return Err(ModelError::WriteoffDisallowed(
                        "claim is not PartiallyPaid".into(),
                    ));
                }
                if !claim.lock.is_none() {
                    return Err(ModelError::WriteoffDisallowed("claim is locked".into()));
                }
                self.hook
                    .check_writeoff(claim)
                    .map_err(ModelError::HookRefusal)?;

                let shortfall = claim.outstanding();
                claim.status = Status::Closed;

                if self.mutations.allow_counter_decrement {
                    claim.booked_total = claim.booked_total.saturating_sub(1);
                }

                Ok(vec![Event::Writeoff {
                    token_id,
                    shortfall,
                }])
            }

            Action::ReleaseSurplus { caller, token_id } => {
                let claim = self
                    .claims
                    .get_mut(&token_id)
                    .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;
                if claim.owner_id != caller {
                    return Err(ModelError::Unauthorized(
                        "only owner can release surplus".into(),
                    ));
                }
                if !claim.lock.is_none() {
                    return Err(ModelError::ClaimLocked(
                        "cannot release surplus under lock".into(),
                    ));
                }
                if claim.surplus == 0 {
                    return Err(ModelError::NoSurplus);
                }

                let amount = claim.surplus;
                claim.surplus = 0;
                *self.released_surplus.entry(token_id.clone()).or_default() += amount;
                Ok(vec![Event::SurplusReleased {
                    token_id,
                    amount,
                    receiver: caller,
                }])
            }

            Action::ApplyCredit {
                token_id,
                amount,
                source,
            } => {
                let claim = self
                    .claims
                    .get_mut(&token_id)
                    .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;
                if !matches!(claim.status, Status::Issued | Status::PartiallyPaid) {
                    return Err(ModelError::StatusViolation(
                        "credit only applies to Issued/PartiallyPaid".into(),
                    ));
                }
                if !claim.lock.is_none() {
                    return Err(ModelError::ClaimLocked(
                        "cannot apply credit under lock".into(),
                    ));
                }
                if amount > claim.outstanding() {
                    return Err(ModelError::CreditExceedsOutstanding);
                }
                if let Some(src) = claim.credit_source {
                    if src != source {
                        return Err(ModelError::CreditSourceMismatch);
                    }
                } else {
                    claim.credit_source = Some(source);
                }

                claim.credit_total += amount;
                claim.update_status_paid_rule();

                Ok(vec![Event::CreditApplied {
                    token_id,
                    amount,
                    source,
                }])
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn step_issue(
        &mut self,
        token_id: String,
        kind: u8,
        issuer_id: AccountId,
        owner_id: AccountId,
        debtor: Option<Debtor>,
        terms_hash: Hex32,
        amount_due: u128,
        due_date: u64,
        block: u64,
    ) -> Result<Vec<Event>, ModelError> {
        if self.config.issue_paused {
            return Err(ModelError::IssuePaused);
        }
        if self.claims.contains_key(&token_id) {
            return Err(ModelError::ClaimAlreadyExists(token_id));
        }
        if amount_due == 0 {
            return Err(ModelError::InvalidAmount("amount_due must be > 0".into()));
        }

        let kind_rules = self.get_kind_rules(kind)?;
        if !kind_rules.debtor_optional && debtor.is_none() {
            return Err(ModelError::DebtorRequired);
        }

        let claim_account = format!("{}.openrail.near", token_id);

        let claim = Claim {
            token_id: token_id.clone(),
            kind,
            issuer_id: issuer_id.clone(),
            owner_id: owner_id.clone(),
            claim_account: claim_account.clone(),
            debtor,
            terms_hash,
            amount_due,
            due_date,
            ack: None,
            status: Status::Issued,
            lock: Lock::None,
            settlement_assets: self.config.settlement_assets.clone(),
            booked_total: 0,
            distributed_total: 0,
            fee_total: 0,
            surplus: 0,
            credit_total: 0,
            credit_source: None,
            last_seen_balance: HashMap::new(),
            undistributed: Vec::new(),
            assignment_doc_hash: None,
            created_block: block,
        };

        self.claims.insert(token_id.clone(), claim);

        Ok(vec![Event::Issue {
            token_id,
            owner_id,
            claim_account,
            amount_due,
        }])
    }

    pub fn step_reconcile_start(
        &mut self,
        token_id: String,
        block: u64,
    ) -> Result<Vec<Event>, ModelError> {
        let claim = self
            .claims
            .get_mut(&token_id)
            .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;

        if !claim.lock.allows_transfer() {
            return Err(ModelError::ClaimLocked(
                "reconcile requires None or TransferWindow lock".into(),
            ));
        }

        let prev_lock = claim.lock.clone();
        self.pending_reconciles.insert(token_id.clone(), prev_lock);
        claim.lock = Lock::Reconciling { since: block };

        Ok(vec![Event::ReconcileStarted { token_id }])
    }

    pub fn step_reconcile_callback(
        &mut self,
        token_id: String,
        leg_failures: Vec<bool>,
        callback_ok: bool,
        block: u64,
    ) -> Result<Vec<Event>, ModelError> {
        let claim = self
            .claims
            .get(&token_id)
            .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;

        if !matches!(claim.lock, Lock::Reconciling { .. }) {
            return Err(ModelError::NotReconciling);
        }

        let prev_lock = self
            .pending_reconciles
            .remove(&token_id)
            .unwrap_or(Lock::None);

        if !callback_ok {
            let claim = self.claims.get_mut(&token_id).unwrap();
            claim.lock = prev_lock;
            return Ok(vec![Event::ReconcileFailed { token_id }]);
        }

        let mut events = Vec::new();

        let (settlement_assets, last_seens, status, outstanding) = {
            let mut last_seens = HashMap::new();
            for asset in &claim.settlement_assets {
                let ls = claim.last_seen_balance.get(asset).copied().unwrap_or(0);
                last_seens.insert(asset.clone(), ls);
            }
            (
                claim.settlement_assets.clone(),
                last_seens,
                claim.status,
                claim.outstanding(),
            )
        };

        // Calculate delta across settlement assets
        // Spec 2.5: d_i = balance_i - last_seen_i. If d_i < 0: emit anomaly, treat as 0, set last_seen_i = balance_i
        let mut deltas: Vec<(TokenId, u128, u128)> = Vec::new();
        let mut total_delta: u128 = 0;

        for asset in &settlement_assets {
            let curr_balance = self
                .intents_balances
                .get(&(token_id.clone(), asset.clone()))
                .copied()
                .unwrap_or(0);
            let last_seen = last_seens.get(asset).copied().unwrap_or(0);

            let d_i = if curr_balance < last_seen {
                events.push(Event::Anomaly {
                    token_id: token_id.clone(),
                    asset: asset.clone(),
                    balance: curr_balance,
                    last_seen,
                });
                let claim = self.claims.get_mut(&token_id).unwrap();
                claim.last_seen_balance.insert(asset.clone(), curr_balance);
                0
            } else {
                curr_balance - last_seen
            };

            total_delta += d_i;
            deltas.push((asset.clone(), d_i, curr_balance));
        }

        // Idempotent: zero delta changes no state (beyond any anomaly last_seen reset)
        if total_delta == 0 {
            let claim = self.claims.get_mut(&token_id).unwrap();
            claim.lock = match prev_lock {
                Lock::TransferWindow { until } if block < until => Lock::TransferWindow { until },
                _ => Lock::None,
            };
            return Ok(events);
        }

        // Booking calculation
        let (payment, credit) = if status.is_terminal() || status == Status::Paid {
            (0, 0)
        } else {
            let claim = self.claims.get(&token_id).unwrap();
            self.hook
                .adjust_booking(claim, total_delta, outstanding, block)
        };

        let surplus_part = total_delta - payment;

        let fee = if self.mutations.wrong_fee_rate {
            (payment * 25 / 10_000) + 1
        } else {
            payment * 25 / 10_000
        };

        let net = payment - fee;

        let mut legs = {
            let claim = self.claims.get(&token_id).unwrap();
            self.hook.split_distribution(claim, net)
        };
        if fee > 0 {
            legs.push(Leg::pay(self.config.fee_account.clone(), fee));
        }

        // Update booking state
        {
            let claim = self.claims.get_mut(&token_id).unwrap();
            if self.mutations.broken_conservation {
                claim.booked_total += total_delta;
                claim.surplus += surplus_part;
                claim.distributed_total += net;
            } else {
                claim.booked_total += total_delta;
                claim.surplus += surplus_part;
                claim.fee_total += fee;
                claim.distributed_total += net;
            }

            claim.credit_total += credit;
            if credit > 0 && claim.credit_source.is_none() {
                claim.credit_source = Some(0);
            }

            claim.update_status_paid_rule();
        }

        events.push(Event::Booked {
            token_id: token_id.clone(),
            payment,
            surplus_part,
            fee,
            credit,
            legs: legs.clone(),
        });

        // Assign legs to settlement assets (largest delta first)
        deltas.sort_by_key(|a| std::cmp::Reverse(a.1));
        let mut asset_idx = 0;
        let mut forwarded_per_asset: HashMap<TokenId, u128> = HashMap::new();

        for leg in &mut legs {
            while asset_idx < deltas.len() && deltas[asset_idx].1 == 0 {
                asset_idx += 1;
            }
            let chosen_asset = if asset_idx < deltas.len() {
                deltas[asset_idx].0.clone()
            } else {
                settlement_assets[0].clone()
            };
            leg.set_asset(chosen_asset.clone());
            *forwarded_per_asset.entry(chosen_asset).or_default() += leg.amount();
        }

        // Set last seen balance: curr_balance - sum(forwarded)
        for (asset, _d, curr_bal) in &deltas {
            let forwarded = forwarded_per_asset.get(asset).copied().unwrap_or(0);
            let new_last_seen = curr_bal.saturating_sub(forwarded);
            let claim = self.claims.get_mut(&token_id).unwrap();
            claim.last_seen_balance.insert(asset.clone(), new_last_seen);

            if let Some(bal) = self
                .intents_balances
                .get_mut(&(token_id.clone(), asset.clone()))
            {
                *bal = bal.saturating_sub(forwarded);
            }
        }

        // Process distribution leg outcomes (D-S8)
        for (idx, leg) in legs.into_iter().enumerate() {
            let failed = leg_failures.get(idx).copied().unwrap_or(false);
            if failed {
                let claim = self.claims.get_mut(&token_id).unwrap();
                claim.undistributed.push(leg.clone());
                if let Some(asset) = leg.asset() {
                    *claim.last_seen_balance.entry(asset.clone()).or_default() += leg.amount();
                    *self
                        .intents_balances
                        .entry((token_id.clone(), asset.clone()))
                        .or_default() += leg.amount();
                }
                events.push(Event::DistributionFailed {
                    token_id: token_id.clone(),
                    leg: leg.clone(),
                });

                if self.mutations.unbook_on_failed_distribution {
                    claim.booked_total = claim.booked_total.saturating_sub(leg.amount());
                    claim.distributed_total = claim.distributed_total.saturating_sub(leg.amount());
                    claim.update_status_paid_rule();
                }
            } else {
                events.push(Event::Distributed {
                    token_id: token_id.clone(),
                    leg,
                });
            }
        }

        // Restore lock
        {
            let claim = self.claims.get_mut(&token_id).unwrap();
            claim.lock = match prev_lock {
                Lock::TransferWindow { until } if block < until => Lock::TransferWindow { until },
                _ => Lock::None,
            };
        }

        Ok(events)
    }

    pub fn step_reconcile(
        &mut self,
        token_id: String,
        leg_failures: Vec<bool>,
        block: u64,
    ) -> Result<Vec<Event>, ModelError> {
        let mut events = self.step_reconcile_start(token_id.clone(), block)?;
        let callback_events = self.step_reconcile_callback(token_id, leg_failures, true, block)?;
        events.extend(callback_events);
        Ok(events)
    }

    fn step_retry_distribution(
        &mut self,
        token_id: String,
        leg_failures: Vec<bool>,
    ) -> Result<Vec<Event>, ModelError> {
        let old_undistributed = {
            let claim = self
                .claims
                .get_mut(&token_id)
                .ok_or_else(|| ModelError::ClaimNotFound(token_id.clone()))?;
            std::mem::take(&mut claim.undistributed)
        };

        let mut events = Vec::new();
        let mut remaining_undistributed = Vec::new();

        for (idx, leg) in old_undistributed.into_iter().enumerate() {
            let failed = leg_failures.get(idx).copied().unwrap_or(false);
            if failed {
                remaining_undistributed.push(leg.clone());
                events.push(Event::DistributionFailed {
                    token_id: token_id.clone(),
                    leg,
                });
            } else {
                // Succeeded: funds leave claim account
                if let Some(asset) = leg.asset() {
                    let claim = self.claims.get_mut(&token_id).unwrap();
                    if let Some(ls) = claim.last_seen_balance.get_mut(asset) {
                        *ls = ls.saturating_sub(leg.amount());
                    }
                    if let Some(bal) = self
                        .intents_balances
                        .get_mut(&(token_id.clone(), asset.clone()))
                    {
                        *bal = bal.saturating_sub(leg.amount());
                    }
                }
                events.push(Event::Distributed {
                    token_id: token_id.clone(),
                    leg,
                });
            }
        }

        let claim = self.claims.get_mut(&token_id).unwrap();
        claim.undistributed = remaining_undistributed;
        Ok(events)
    }
}

impl Default for Model {
    fn default() -> Self {
        Self::new()
    }
}
