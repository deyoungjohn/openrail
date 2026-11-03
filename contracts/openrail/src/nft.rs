//! NEP-171 / NEP-177 / NEP-178 / NEP-181 bodies and the Blueprint 2.4 transfer rules.

use crate::events::{NftTransferEvent, TransferWindowEvent};
use crate::hooks;
use crate::types::{Claim, Hex32, JsonToken, Lock, NFTContractMetadata, Status};
use crate::Contract;
use near_sdk::json_types::U128;
use near_sdk::{env, require, AccountId, Gas};
use std::collections::HashMap;

const GAS_FOR_NFT_ON_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_FOR_NFT_RESOLVE: Gas = Gas::from_tgas(20);
const TRANSFER_WINDOW_BLOCKS: u64 = 1_800;
const DEFAULT_LIMIT: u64 = 50;

fn claim_or_panic(contract: &Contract, token_id: &str) -> Claim {
    contract
        .claims
        .get(token_id)
        .cloned()
        .unwrap_or_else(|| env::panic_str("claim not found"))
}

fn is_sale(claim: &Claim, receiver: &AccountId) -> bool {
    receiver != &claim.issuer_id
}

fn parse_assignment_hash(memo: &Option<String>) -> Option<Hex32> {
    let raw = memo.as_ref()?;
    let without_prefix = raw.strip_prefix("0x").unwrap_or(raw);
    if without_prefix.len() != 64 || !without_prefix.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Hex32::from_hex(&format!("0x{without_prefix}")).ok()
}

fn lock_allows_transfer(lock: &Lock) -> bool {
    matches!(lock, Lock::None | Lock::TransferWindow { .. })
}

impl Contract {
    fn approvals_of(&self, token_id: &str) -> HashMap<AccountId, u64> {
        self.approvals.get(token_id).cloned().unwrap_or_default()
    }

    fn set_approvals(&mut self, token_id: &str, approvals: HashMap<AccountId, u64>) {
        if approvals.is_empty() {
            self.approvals.remove(token_id);
        } else {
            self.approvals.insert(token_id.to_string(), approvals);
        }
    }

    fn is_owner_or_approved(
        &self,
        claim: &Claim,
        caller: &AccountId,
        approval_id: Option<u64>,
    ) -> Option<Option<AccountId>> {
        if caller == &claim.owner_id {
            return Some(None);
        }
        let approvals = self.approvals_of(&claim.token_id);
        let stored = approvals.get(caller)?;
        if let Some(expected) = approval_id {
            if expected != *stored {
                return None;
            }
        }
        Some(Some(caller.clone()))
    }

    /// Blueprint 2.4 rules 1–8, in the order that makes the named tests unambiguous:
    /// deposit first, then lock, status, sellability, receiver, ack, assignment doc, hooks.
    fn assert_transfer_rules(&self, claim: &Claim, receiver: &AccountId, memo: &Option<String>) {
        require!(
            env::attached_deposit().as_yoctonear() == 1,
            crate::ERR_RULE_6_YOCTO_DEPOSIT
        );
        require!(lock_allows_transfer(&claim.lock), crate::ERR_RULE_1_LOCK);
        require!(
            matches!(claim.status, Status::Issued | Status::PartiallyPaid),
            crate::ERR_RULE_2_STATUS
        );

        let rules = hooks::dispatch_kind_rules(claim.kind);
        require!(rules.sellable, crate::ERR_RULE_7_NOT_SELLABLE);
        let sale = is_sale(claim, receiver);
        require!(
            receiver != &claim.claim_account,
            crate::ERR_RULE_5_RECEIVER_NOT_CLAIM
        );
        if sale && rules.ack_required_for_sale {
            require!(claim.ack.is_some(), crate::ERR_RULE_3_ACK_REQUIRED);
        }
        if sale {
            require!(
                parse_assignment_hash(memo).is_some(),
                crate::ERR_RULE_4_ASSIGNMENT_DOC
            );
        }
        if let Err(refusal) = hooks::dispatch_check_transfer(claim, receiver) {
            env::panic_str(&format!("Rule 8: hook transfer check refused: {refusal}"));
        }
    }

    fn move_token(
        &mut self,
        claim: &mut Claim,
        receiver: &AccountId,
        memo: &Option<String>,
        authorized_id: Option<AccountId>,
    ) -> (AccountId, HashMap<AccountId, u64>) {
        let previous_owner = claim.owner_id.clone();
        let previous_approvals = self.approvals_of(&claim.token_id);

        self.internal_remove_owner_token(&previous_owner, &claim.token_id);
        self.internal_add_owner_token(receiver, &claim.token_id);
        claim.owner_id = receiver.clone();
        if is_sale(claim, receiver) {
            claim.assignment_doc_hash = parse_assignment_hash(memo);
        }
        claim.lock = Lock::None;
        self.claims.insert(claim.token_id.clone(), claim.clone());
        self.set_approvals(&claim.token_id, HashMap::new());

        NftTransferEvent {
            authorized_id,
            old_owner_id: previous_owner.clone(),
            new_owner_id: receiver.clone(),
            token_ids: vec![claim.token_id.clone()],
            memo: memo.clone(),
        }
        .emit();

        (previous_owner, previous_approvals)
    }

    pub(crate) fn internal_nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        let mut claim = claim_or_panic(self, &token_id);
        let caller = env::predecessor_account_id();
        let authorized = self
            .is_owner_or_approved(&claim, &caller, approval_id)
            .unwrap_or_else(|| env::panic_str("Unauthorized: owner or approved account only"));
        self.assert_transfer_rules(&claim, &receiver_id, &memo);
        self.move_token(&mut claim, &receiver_id, &memo, authorized);
    }

    pub(crate) fn internal_nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> bool {
        let mut claim = claim_or_panic(self, &token_id);
        let caller = env::predecessor_account_id();
        let authorized = self
            .is_owner_or_approved(&claim, &caller, approval_id)
            .unwrap_or_else(|| env::panic_str("Unauthorized: owner or approved account only"));
        self.assert_transfer_rules(&claim, &receiver_id, &memo);
        let previous_lock = claim.lock.clone();
        let previous_assignment = claim.assignment_doc_hash;
        let (previous_owner, previous_approvals) =
            self.move_token(&mut claim, &receiver_id, &memo, authorized);
        claim.lock = Lock::TransferWindow {
            until: env::block_height() + TRANSFER_WINDOW_BLOCKS,
        };
        self.claims.insert(token_id.clone(), claim);
        self.transfer_call_state
            .insert(token_id.clone(), (previous_lock, previous_assignment));

        let call_args = near_sdk::serde_json::json!({
            "sender_id": caller,
            "previous_owner_id": previous_owner,
            "token_id": token_id,
            "msg": msg,
        })
        .to_string();
        let call = env::promise_batch_create(&receiver_id);
        env::promise_batch_action_function_call(
            call,
            "nft_on_transfer",
            call_args.as_bytes(),
            near_sdk::NearToken::ZERO,
            GAS_FOR_NFT_ON_TRANSFER,
        );
        let resolve_args = near_sdk::serde_json::json!({
            "previous_owner_id": previous_owner,
            "receiver_id": receiver_id,
            "token_id": token_id,
            "approved_account_ids": previous_approvals,
        })
        .to_string();
        let resolve = env::promise_batch_then(call, &env::current_account_id());
        env::promise_batch_action_function_call(
            resolve,
            "nft_resolve_transfer",
            resolve_args.as_bytes(),
            near_sdk::NearToken::ZERO,
            GAS_FOR_NFT_RESOLVE,
        );
        env::promise_return(resolve);
        true
    }

    pub(crate) fn internal_nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        let refund = match env::promise_result_checked(0, 1024) {
            Ok(bytes) => near_sdk::serde_json::from_slice::<bool>(&bytes).unwrap_or(true),
            Err(_) => true,
        };
        let previous = self.transfer_call_state.remove(&token_id);
        let Some(mut claim) = self.claims.get(&token_id).cloned() else {
            return false;
        };
        if claim.owner_id != receiver_id {
            // The receiver moved the token on inside `nft_on_transfer`; nothing to refund.
            return true;
        }
        if !refund {
            claim.lock = Lock::None;
            self.claims.insert(token_id, claim);
            return false;
        }
        // The receiver still owns the token and asked for a refund: restore the sender.
        self.internal_remove_owner_token(&receiver_id, &token_id);
        self.internal_add_owner_token(&previous_owner_id, &token_id);
        claim.owner_id = previous_owner_id.clone();
        claim.assignment_doc_hash = previous.as_ref().and_then(|(_, assignment)| *assignment);
        claim.lock = previous.map(|(lock, _)| lock).unwrap_or(Lock::None);
        self.claims.insert(token_id.clone(), claim);
        self.set_approvals(&token_id, approved_account_ids.unwrap_or_default());
        NftTransferEvent {
            authorized_id: None,
            old_owner_id: receiver_id,
            new_owner_id: previous_owner_id,
            token_ids: vec![token_id],
            memo: None,
        }
        .emit();
        true
    }

    pub(crate) fn internal_nft_approve(
        &mut self,
        token_id: String,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<u64> {
        let _ = msg;
        require!(
            env::attached_deposit().as_yoctonear() >= 1,
            "Requires attached deposit of at least 1 yoctoNEAR"
        );
        let claim = claim_or_panic(self, &token_id);
        let caller = env::predecessor_account_id();
        require!(
            self.is_owner_or_approved(&claim, &caller, None).is_some(),
            "Unauthorized: owner or approved account only"
        );
        let mut approvals = self.approvals_of(&token_id);
        let next = approvals.values().copied().max().unwrap_or(0) + 1;
        approvals.insert(account_id, next);
        self.set_approvals(&token_id, approvals);
        Some(next)
    }

    pub(crate) fn internal_nft_revoke(&mut self, token_id: String, account_id: AccountId) {
        require!(
            env::attached_deposit().as_yoctonear() == 1,
            crate::ERR_RULE_6_YOCTO_DEPOSIT
        );
        let claim = claim_or_panic(self, &token_id);
        require!(
            env::predecessor_account_id() == claim.owner_id,
            "Unauthorized: owner only"
        );
        let mut approvals = self.approvals_of(&token_id);
        if approvals.remove(&account_id).is_some() {
            self.set_approvals(&token_id, approvals);
        }
    }

    pub(crate) fn internal_nft_revoke_all(&mut self, token_id: String) {
        require!(
            env::attached_deposit().as_yoctonear() == 1,
            crate::ERR_RULE_6_YOCTO_DEPOSIT
        );
        let claim = claim_or_panic(self, &token_id);
        require!(
            env::predecessor_account_id() == claim.owner_id,
            "Unauthorized: owner only"
        );
        self.set_approvals(&token_id, HashMap::new());
    }

    pub(crate) fn internal_nft_is_approved(
        &self,
        token_id: String,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool {
        let approvals = self.approvals_of(&token_id);
        let Some(stored) = approvals.get(&approved_account_id) else {
            return false;
        };
        approval_id.is_none_or(|expected| expected == *stored)
    }

    pub(crate) fn internal_nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: "nft-1.0.0".to_string(),
            name: "Openrail Claim".to_string(),
            symbol: "OPENRAIL".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    fn token_view(&self, token_id: &str) -> Option<JsonToken> {
        let claim = self.claims.get(token_id)?.clone();
        let metadata = self
            .token_metadata
            .get(token_id)
            .cloned()
            .unwrap_or_default();
        let approvals = self.approvals_of(token_id);
        Some(JsonToken {
            token_id: token_id.to_string(),
            owner_id: claim.owner_id,
            metadata: Some(metadata),
            approved_account_ids: if approvals.is_empty() {
                None
            } else {
                Some(approvals)
            },
        })
    }

    pub(crate) fn internal_nft_token(&self, token_id: &str) -> Option<JsonToken> {
        self.token_view(token_id)
    }

    pub(crate) fn internal_nft_total_supply(&self) -> U128 {
        let mut count = 0u128;
        for n in 1..self.next_token_id {
            if self.claims.contains_key(&crate::claims::format_token_id(n)) {
                count += 1;
            }
        }
        U128(count)
    }

    pub(crate) fn internal_nft_tokens(
        &self,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<JsonToken> {
        let from = from_index.map(|value| value.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(DEFAULT_LIMIT).max(1) as usize;
        let mut out = Vec::new();
        let mut seen = 0usize;
        for n in 1..self.next_token_id {
            let token_id = crate::claims::format_token_id(n);
            let Some(view) = self.token_view(&token_id) else {
                continue;
            };
            if seen >= from {
                out.push(view);
                if out.len() >= limit {
                    break;
                }
            }
            seen += 1;
        }
        out
    }

    pub(crate) fn internal_nft_supply_for_owner(&self, account_id: &AccountId) -> U128 {
        U128(
            self.owner_index
                .get(account_id)
                .map(|tokens| tokens.len() as u128)
                .unwrap_or(0),
        )
    }

    pub(crate) fn internal_nft_tokens_for_owner(
        &self,
        account_id: &AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<JsonToken> {
        let from = from_index.map(|value| value.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(DEFAULT_LIMIT).max(1) as usize;
        let tokens = self
            .owner_index
            .get(account_id)
            .cloned()
            .unwrap_or_default();
        tokens
            .iter()
            .skip(from)
            .filter_map(|token_id| self.token_view(token_id))
            .take(limit)
            .collect()
    }

    pub(crate) fn internal_prepare_transfer(&mut self, token_id: String) {
        let mut claim = claim_or_panic(self, &token_id);
        require!(
            env::predecessor_account_id() == claim.owner_id,
            "Unauthorized: owner only"
        );
        require!(lock_allows_transfer(&claim.lock), crate::ERR_RULE_1_LOCK);
        let rules = hooks::dispatch_kind_rules(claim.kind);
        require!(rules.sellable, crate::ERR_RULE_7_NOT_SELLABLE);
        if let Err(refusal) = hooks::dispatch_check_transfer(&claim, &claim.owner_id) {
            env::panic_str(&format!("Rule 8: hook transfer check refused: {refusal}"));
        }
        let until = env::block_height() + TRANSFER_WINDOW_BLOCKS;
        claim.lock = Lock::TransferWindow { until };
        self.claims.insert(token_id.clone(), claim);
        TransferWindowEvent { token_id, until }.emit();
    }
}
