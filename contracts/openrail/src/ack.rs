//! Debtor acknowledgement (NEAR / EIP-712) and the cancel co-signature (Blueprint 2.7).

use crate::eip712::{
    ack_digest, cancel_digest, recover_address, AckError, EnvEcrecover, OPENRAIL_ACK,
};
use crate::events::{AckEvent, CancelEvent};
use crate::hooks;
use crate::types::{Ack, AckScheme, Claim, Debtor, DebtorCosig, Hex20, Lock};
use crate::Contract;
use near_sdk::{env, require};

const ACCEPTED_CHAIN_IDS: [u64; 6] = [1, 10, 56, 137, 8453, 42161];

fn claim_or_panic(contract: &Contract, token_id: &str) -> Claim {
    contract
        .claims
        .get(token_id)
        .cloned()
        .unwrap_or_else(|| env::panic_str("claim not found"))
}

fn require_unacked(claim: &Claim) {
    require!(claim.ack.is_none(), "already acknowledged");
}

fn recover_or_panic(digest: &[u8; 32], sig: &[u8]) -> Hex20 {
    match recover_address(&EnvEcrecover, digest, sig) {
        Ok(address) => Hex20(address),
        Err(AckError::BadV) => env::panic_str("BAD_V"),
        Err(AckError::ContractWallet) => {
            env::panic_str("contract wallets: acknowledge from a NEAR account or an EOA")
        }
        Err(_) => env::panic_str("BAD_SIGNATURE"),
    }
}

impl Contract {
    pub(crate) fn internal_acknowledge_near(&mut self, token_id: String) {
        let mut claim = claim_or_panic(self, &token_id);
        let caller = env::predecessor_account_id();
        require!(
            matches!(&claim.debtor, Some(Debtor::Near(account)) if account == &caller),
            "caller is not the Near debtor"
        );
        require_unacked(&claim);
        let block = env::block_height();
        claim.ack = Some(Ack {
            scheme: AckScheme::Near {
                account: caller.clone(),
            },
            block,
        });
        self.claims.insert(token_id.clone(), claim);
        AckEvent {
            token_id,
            scheme: AckScheme::Near { account: caller },
            block,
        }
        .emit();
    }

    pub(crate) fn internal_acknowledge_evm(
        &mut self,
        token_id: String,
        chain_id: u64,
        sig: crate::types::HexBytes,
    ) {
        require!(
            ACCEPTED_CHAIN_IDS.contains(&chain_id),
            "chain id is not a pay-link chain"
        );
        let mut claim = claim_or_panic(self, &token_id);
        let debtor = match &claim.debtor {
            Some(Debtor::Evm(address)) => *address,
            _ => env::panic_str("claim has no EVM debtor"),
        };
        require_unacked(&claim);
        let digest = ack_digest(
            OPENRAIL_ACK,
            chain_id,
            env::current_account_id().as_str(),
            &claim.token_id,
            claim.terms_hash.as_bytes(),
            claim.amount_due.0,
            claim.due_date,
        );
        let recovered = recover_or_panic(&digest, sig.as_bytes());
        require!(recovered == debtor, "signer is not the debtor");
        let block = env::block_height();
        let scheme = AckScheme::Evm {
            chain_id,
            signer: recovered,
        };
        claim.ack = Some(Ack {
            scheme: scheme.clone(),
            block,
        });
        self.claims.insert(token_id.clone(), claim);
        AckEvent {
            token_id,
            scheme,
            block,
        }
        .emit();
    }

    pub(crate) fn internal_cancel(&mut self, token_id: String, debtor_cosig: Option<DebtorCosig>) {
        let mut claim = claim_or_panic(self, &token_id);
        let caller = env::predecessor_account_id();
        require!(
            claim.booked_total.0 == 0 && claim.credit_total.0 == 0,
            "claim has booked value or credit"
        );
        require!(matches!(claim.lock, Lock::None), "claim is locked");
        if let Err(refusal) = hooks::dispatch_check_cancel(&claim) {
            env::panic_str(&format!("Rule 8: hook cancel check refused: {refusal}"));
        }

        match (&claim.ack, &claim.debtor) {
            (Some(_), Some(Debtor::Near(account))) => {
                require!(&caller == account, "debtor co-signature required");
            }
            (Some(_), Some(Debtor::Evm(address))) => {
                let cosig =
                    debtor_cosig.unwrap_or_else(|| env::panic_str("debtor co-signature required"));
                let (chain_id, sig) = match cosig {
                    DebtorCosig::Evm { chain_id, sig } => (chain_id, sig),
                    DebtorCosig::Near => env::panic_str("debtor co-signature required"),
                };
                require!(
                    ACCEPTED_CHAIN_IDS.contains(&chain_id),
                    "chain id is not a pay-link chain"
                );
                let digest = cancel_digest(
                    chain_id,
                    env::current_account_id().as_str(),
                    &claim.token_id,
                );
                let recovered = recover_or_panic(&digest, sig.as_bytes());
                require!(&recovered == address, "signer is not the debtor");
            }
            _ => {
                require!(caller == claim.owner_id, "Unauthorized: owner only");
            }
        }
        require!(
            caller == claim.owner_id
                || matches!(&claim.debtor, Some(Debtor::Near(account)) if account == &caller),
            "Unauthorized: owner or Near debtor only"
        );

        claim.status = crate::types::Status::Cancelled;
        self.claims.insert(token_id.clone(), claim);
        CancelEvent {
            token_id,
            reason: None,
        }
        .emit();
    }
}
