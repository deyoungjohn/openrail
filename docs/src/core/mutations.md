# Contract mutation checks

These are deliberate rule breaks applied to the contract code and runner scripts, each run against the named acceptance test, then restored. C2/C3 are recorded at commit [`cd54fa9`](https://github.com/deyoungjohn/openrail/commit/cd54fa9), based on [`44361a3`](https://github.com/deyoungjohn/openrail/commit/44361a3) (PR [#54](https://github.com/deyoungjohn/openrail/pull/54)); C4 and C5 are recorded on branch `ph1-c5-lifecycle` (PR [#71](https://github.com/deyoungjohn/openrail/pull/71)); G1 runner mutations are recorded on branch `ph1-t2-g1-safety` (PR [#97](https://github.com/deyoungjohn/openrail/pull/97)); H8 mutations are recorded on branch `ph2-h8-live-nft`.

## Reproduce

```bash
# apply one diff below, then from the repository root:
rm -rf target/near/openrail
NEAR_SANDBOX_BIN_PATH="$HOME/.near/sandbox" cargo test -p openrail-tests --test <suite> <test>
# expected: FAILED, with the listed test failing
git checkout -- contracts/openrail/src
```

The working tree was clean after restoring all mutations (`git diff --exit-code` exited 0).

## C2 — NEP-171 transfers

| ID    | Break                                        | Test                                                          | Result          |
| ----- | -------------------------------------------- | ------------------------------------------------------------- | --------------- |
| C2-M1 | exact 1 yocto removed                        | `nft_transfer_requires_one_yocto`                             | FAILED (caught) |
| C2-M2 | ack rule removed                             | `nft_transfer_rules_enforced`                                 | FAILED (caught) |
| C2-M3 | assignment memo rule removed                 | `nft_transfer_rules_enforced`                                 | FAILED (caught) |
| C2-M4 | claim-account receiver rule removed          | `no_self_ownership`                                           | FAILED (caught) |
| C2-M5 | approvals not cleared on transfer            | `nft_transfer_only_owner_or_approved`                         | FAILED (caught) |
| C2-M6 | owner index swap-remove reverse key disabled | `nft_owner_index_enumeration_and_pagination_across_transfers` | FAILED (caught) |

### C2-M1: exact 1 yocto removed

Command: `cargo test -p openrail-tests --test nft_suite nft_transfer_requires_one_yocto`

```diff
--- a/contracts/openrail/src/nft.rs
+++ b/contracts/openrail/src/nft.rs
@@ -73,10 +73,6 @@
     /// Blueprint 2.4 rules 1–8, in the order that makes the named tests unambiguous:
     /// deposit first, then lock, status, sellability, receiver, ack, assignment doc, hooks.
     fn assert_transfer_rules(&self, claim: &Claim, receiver: &AccountId, memo: &Option<String>) {
-        require!(
-            env::attached_deposit().as_yoctonear() == 1,
-            crate::ERR_RULE_6_YOCTO_DEPOSIT
-        );
         require!(lock_allows_transfer(&claim.lock), crate::ERR_RULE_1_LOCK);
         require!(
             matches!(claim.status, Status::Issued | Status::PartiallyPaid),
```

Failure (tail):

```text
test nft_transfer_requires_one_yocto ... FAILED
thread 'nft_transfer_requires_one_yocto' (3138175) panicked at contracts/tests/tests/nft_suite.rs:164:5:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 9 filtered out; finished in 58.90s
```

### C2-M2: ack rule removed

Command: `cargo test -p openrail-tests --test nft_suite nft_transfer_rules_enforced`

```diff
--- a/contracts/openrail/src/nft.rs
+++ b/contracts/openrail/src/nft.rs
@@ -90,9 +90,6 @@
             receiver != &claim.claim_account,
             crate::ERR_RULE_5_RECEIVER_NOT_CLAIM
         );
-        if sale && rules.ack_required_for_sale {
-            require!(claim.ack.is_some(), crate::ERR_RULE_3_ACK_REQUIRED);
-        }
         if sale {
             require!(
                 parse_assignment_hash(memo).is_some(),
```

Failure (tail):

```text
test nft_transfer_rules_enforced ... FAILED
thread 'nft_transfer_rules_enforced' (3173655) panicked at contracts/tests/tests/nft_suite.rs:439:5:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 9 filtered out; finished in 51.07s
```

### C2-M3: assignment memo rule removed

Command: `cargo test -p openrail-tests --test nft_suite nft_transfer_rules_enforced`

```diff
--- a/contracts/openrail/src/nft.rs
+++ b/contracts/openrail/src/nft.rs
@@ -92,12 +92,6 @@
         );
         if sale && rules.ack_required_for_sale {
             require!(claim.ack.is_some(), crate::ERR_RULE_3_ACK_REQUIRED);
-        }
-        if sale {
-            require!(
-                parse_assignment_hash(memo).is_some(),
-                crate::ERR_RULE_4_ASSIGNMENT_DOC
-            );
         }
         if let Err(refusal) = hooks::dispatch_check_transfer(claim, receiver) {
             env::panic_str(&format!("Rule 8: hook transfer check refused: {refusal}"));
```

Failure (tail):

```text
test nft_transfer_rules_enforced ... FAILED
thread 'nft_transfer_rules_enforced' (3189175) panicked at contracts/tests/tests/nft_suite.rs:470:5:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 9 filtered out; finished in 84.11s
```

### C2-M4: claim-account receiver rule removed

Command: `cargo test -p openrail-tests --test core_suite no_self_ownership`

```diff
--- a/contracts/openrail/src/nft.rs
+++ b/contracts/openrail/src/nft.rs
@@ -86,10 +86,6 @@
         let rules = hooks::dispatch_kind_rules(claim.kind);
         require!(rules.sellable, crate::ERR_RULE_7_NOT_SELLABLE);
         let sale = is_sale(claim, receiver);
-        require!(
-            receiver != &claim.claim_account,
-            crate::ERR_RULE_5_RECEIVER_NOT_CLAIM
-        );
         if sale && rules.ack_required_for_sale {
             require!(claim.ack.is_some(), crate::ERR_RULE_3_ACK_REQUIRED);
         }
```

Failure (tail):

```text
test no_self_ownership ... FAILED
thread 'no_self_ownership' (3257784) panicked at contracts/tests/tests/core_suite.rs:490:5:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 19 filtered out; finished in 57.18s
```

### C2-M5: approvals not cleared on transfer

Command: `cargo test -p openrail-tests --test nft_suite nft_transfer_only_owner_or_approved`

```diff
--- a/contracts/openrail/src/nft.rs
+++ b/contracts/openrail/src/nft.rs
@@ -122,7 +122,6 @@
         }
         claim.lock = Lock::None;
         self.claims.insert(claim.token_id.clone(), claim.clone());
-        self.set_approvals(&claim.token_id, HashMap::new());

         NftTransferEvent {
             authorized_id,
```

Failure (tail):

```text
test nft_transfer_only_owner_or_approved ... FAILED
thread 'nft_transfer_only_owner_or_approved' (3296308) panicked at contracts/tests/tests/nft_suite.rs:371:5:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 9 filtered out; finished in 58.54s
```

### C2-M6: owner index swap-remove reverse key disabled

Command: `cargo test -p openrail-tests --test nft_suite nft_owner_index_enumeration_and_pagination_across_transfers`

```diff
--- a/contracts/openrail/src/claims.rs
+++ b/contracts/openrail/src/claims.rs
@@ -126,6 +126,5 @@
         // Execute uniform swap-write then remove so gas cost is constant regardless of idx == last_idx.
         env::storage_write(&idx_i_key, &last_token);
-        env::storage_write(&last_k_key, &idx.to_le_bytes());
         env::storage_remove(&last_i_key);
         env::storage_remove(&k_key);
```

Failure (tail):

```text
test nft_owner_index_enumeration_and_pagination_across_transfers ... FAILED
thread 'nft_owner_index_enumeration_and_pagination_across_transfers' (1928423) panicked at contracts/tests/tests/nft_suite.rs:1292:5:
assertion `left == right` failed
  left: ["c-1", "c-8", "c-3", "c-4", "c-5", "c-6"]
 right: ["c-1", "c-7", "c-3", "c-4", "c-5", "c-6"]
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 10 filtered out; finished in 59.66s
```

## C3 — acknowledgement

| ID    | Break                              | Test                        | Result          |
| ----- | ---------------------------------- | --------------------------- | --------------- |
| C3-M1 | write-once check removed           | `contract_ack_only_once`    | FAILED (caught) |
| C3-M2 | wrong-signer check removed         | `contract_ack_wrong_signer` | FAILED (caught) |
| C3-M3 | high-s malleability guard disabled | `ack_high_s_rejected`       | FAILED (caught) |
| C3-M4 | v not normalised                   | `contract_ack_eip712_valid` | FAILED (caught) |
| C3-M5 | K14 scheme used for Openrail ack   | `contract_ack_eip712_valid` | FAILED (caught) |

### C3-M1: write-once check removed

Command: `cargo test -p openrail-tests --test ack_suite contract_ack_only_once`

```diff
--- a/contracts/openrail/src/ack.rs
+++ b/contracts/openrail/src/ack.rs
@@ -74,7 +74,6 @@
             Some(Debtor::Evm(address)) => *address,
             _ => env::panic_str("claim has no EVM debtor"),
         };
-        require_unacked(&claim);
         let digest = ack_digest(
             OPENRAIL_ACK,
             chain_id,
```

Failure (tail):

```text
test contract_ack_only_once ... FAILED
thread 'contract_ack_only_once' (3354425) panicked at contracts/tests/tests/ack_suite.rs:931:5:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 18 filtered out; finished in 109.82s
```

### C3-M2: wrong-signer check removed

Command: `cargo test -p openrail-tests --test ack_suite contract_ack_wrong_signer`

```diff
--- a/contracts/openrail/src/ack.rs
+++ b/contracts/openrail/src/ack.rs
@@ -85,7 +85,6 @@
             claim.due_date,
         );
         let recovered = recover_or_panic(&digest, sig.as_bytes());
-        require!(recovered == debtor, "signer is not the debtor");
         let block = env::block_height();
         let scheme = AckScheme::Evm {
             chain_id,
```

Failure (tail):

```text
test contract_ack_wrong_signer ... FAILED
thread 'contract_ack_wrong_signer' (3422445) panicked at contracts/tests/tests/ack_suite.rs:503:5:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 18 filtered out; finished in 79.29s
```

### C3-M3: high-s malleability guard disabled

Command: `cargo test -p openrail-tests --test ack_suite ack_high_s_rejected`

```diff
--- a/contracts/openrail/src/eip712.rs
+++ b/contracts/openrail/src/eip712.rs
@@ -209,7 +209,7 @@
         .try_into()
         .map_err(|_| AckError::BadLength)?;
     let public_key = recover
-        .ecrecover(digest, &signature64, recovery_id, true)
+        .ecrecover(digest, &signature64, recovery_id, false)
         .ok_or(AckError::BadSignature)?;
     let hash = keccak(&public_key);
     let mut address = [0u8; 20];
```

Failure (tail):

```text
test ack_high_s_rejected ... FAILED
thread 'ack_high_s_rejected' (3470111) panicked at contracts/tests/tests/ack_suite.rs:628:10:
test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 17 filtered out; finished in 54.02s
```

### C3-M4: v not normalised

Command: `cargo test -p openrail-tests --test ack_suite contract_ack_eip712_valid`

```diff
--- a/contracts/openrail/src/eip712.rs
+++ b/contracts/openrail/src/eip712.rs
@@ -201,7 +201,7 @@
         return Err(AckError::ContractWallet);
     }
     let recovery_id = match v {
-        27 | 28 => v - 27,
+        27 | 28 => v,
         v @ (0 | 1) => v,
         _ => return Err(AckError::BadV),
     };
```

Failure (tail):

```text
test contract_ack_eip712_valid ... FAILED
thread 'contract_ack_eip712_valid' (3512352) panicked at contracts/tests/tests/ack_suite.rs:297:5:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 18 filtered out; finished in 73.41s
```

### C3-M5: K14 scheme used for Openrail ack

Command: `cargo test -p openrail-tests --test ack_suite contract_ack_eip712_valid`

```diff
--- a/contracts/openrail/src/ack.rs
+++ b/contracts/openrail/src/ack.rs
@@ -76,7 +76,7 @@
         };
         require_unacked(&claim);
         let digest = ack_digest(
-            OPENRAIL_ACK,
+            crate::eip712::K14_ACK,
             chain_id,
             env::current_account_id().as_str(),
             &claim.token_id,
```

Failure (tail):

```text
test contract_ack_eip712_valid ... FAILED
thread 'contract_ack_eip712_valid' (3557162) panicked at contracts/tests/tests/ack_suite.rs:297:5:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 18 filtered out; finished in 51.97s
```

## C4 — Reconcile and distribution

| ID    | Break                                | Test                                                                   | Result          |
| ----- | ------------------------------------ | ---------------------------------------------------------------------- | --------------- |
| C4-M1 | stale callback guard disabled        | `test_c4_stale_callback_double_book_prevented`                         | FAILED (caught) |
| C4-M2 | missing claim check removed          | `test_c4_mutation_break_2_unknown_claim`                               | FAILED (caught) |
| C4-M3 | protocol fee set to 0 bps            | `test_c4_mutation_break_3_exact_fee_25_bps`                            | FAILED (caught) |
| C4-M4 | D-S8 violation: unbooking failed leg | `test_c4_mutation_break_4_d_s8_failed_leg_preserves_status_and_booked` | FAILED (caught) |
| C4-M5 | anomaly on falling balance removed   | `test_c4_mutation_break_5_falling_balance_anomaly_delta_zero`          | FAILED (caught) |
| C4-M6 | emit a booking event on zero delta   | `reconcile_idempotent`                                                 | FAILED (caught) |

### C4-M1: stale callback guard disabled

Command: `cargo test -p openrail-tests --test c4_reconcile_tests test_c4_stale_callback_double_book_prevented`

```diff
--- a/contracts/openrail/src/reconcile.rs
+++ b/contracts/openrail/src/reconcile.rs
@@ -256,15 +256,6 @@
         match &claim.lock {
             Lock::Reconciling { since: lock_since } => {
-                if *lock_since != since {
-                    ReconcileFailedEvent {
-                        token_id: token_id.clone(),
-                        reason: "stale_callback".to_string(),
-                    }
-                    .emit();
-                    return;
-                }
+                // Stale callback guard bypassed
             }
             _ => {
                 ReconcileFailedEvent {
```

Failure (tail):

```text
test test_c4_stale_callback_double_book_prevented ... FAILED
thread 'test_c4_stale_callback_double_book_prevented' panicked at contracts/tests/tests/c4_reconcile_tests.rs:892:10:
called `Option::unwrap()` on a `None` value (reconcile_failed event must be emitted)
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 14 filtered out; finished in 52.18s
```

### C4-M2: missing claim check removed

Command: `cargo test -p openrail-tests --test c4_reconcile_tests test_c4_mutation_break_2_unknown_claim`

```diff
--- a/contracts/openrail/src/reconcile.rs
+++ b/contracts/openrail/src/reconcile.rs
@@ -207,3 +207,6 @@
-        let claim = self
-            .claims
-            .get_mut(&token_id)
-            .unwrap_or_else(|| env::panic_str("claim not found"));
+        let Some(claim) = self.claims.get_mut(&token_id) else {
+            return;
+        };
```

Failure (tail):

```text
test test_c4_mutation_break_2_unknown_claim ... FAILED
thread 'test_c4_mutation_break_2_unknown_claim' panicked at contracts/tests/tests/c4_reconcile_tests.rs:530:5:
assertion failed: res.is_failure()
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 14 filtered out; finished in 48.33s
```

### C4-M3: protocol fee set to 0 bps

Command: `cargo test -p openrail-tests --test c4_reconcile_tests test_c4_mutation_break_3_exact_fee_25_bps`

```diff
--- a/contracts/openrail/src/reconcile.rs
+++ b/contracts/openrail/src/reconcile.rs
@@ -293,1 +293,1 @@
-        let fee = (total_delta.saturating_mul(25)) / 10_000;
+        let fee = 0;
```

Failure (tail):

```text
test test_c4_mutation_break_3_exact_fee_25_bps ... FAILED
thread 'test_c4_mutation_break_3_exact_fee_25_bps' panicked at contracts/tests/tests/c4_reconcile_tests.rs:575:5:
assertion `left == right` failed: Fee must be exactly 25 bps
  left: 0
 right: 25000
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 14 filtered out; finished in 51.40s
```

### C4-M4: D-S8 violation: unbooking failed leg

Command: `cargo test -p openrail-tests --test c4_reconcile_tests test_c4_mutation_break_4_d_s8_failed_leg_preserves_status_and_booked`

```diff
--- a/contracts/openrail/src/reconcile.rs
+++ b/contracts/openrail/src/reconcile.rs
@@ -590,6 +590,9 @@
             } else {
                 // D-S8: failed leg is recorded into undistributed; booking counters stand!
+                claim.booked_total = near_sdk::json_types::U128(claim.booked_total.0.saturating_sub(leg.amount().0));
+                claim.status = Status::Issued;
+
                 let mut und = self
                     .undistributed
```

Failure (tail):

```text
test test_c4_mutation_break_4_d_s8_failed_leg_preserves_status_and_booked ... FAILED
thread 'test_c4_mutation_break_4_d_s8_failed_leg_preserves_status_and_booked' panicked at contracts/tests/tests/c4_reconcile_tests.rs:629:5:
assertion `left == right` failed: D-S8: Status must remain Paid
  left: Issued
 right: Paid
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 14 filtered out; finished in 53.66s
```

### C4-M5: anomaly on falling balance removed

Command: `cargo test -p openrail-tests --test c4_reconcile_tests test_c4_mutation_break_5_falling_balance_anomaly_delta_zero`

```diff
--- a/contracts/openrail/src/reconcile.rs
+++ b/contracts/openrail/src/reconcile.rs
@@ -241,10 +241,3 @@
                 if bal < last {
-                    AnomalyEvent {
-                        token_id: token_id.clone(),
-                        asset: asset.clone(),
-                        expected: U128(last),
-                        actual: U128(bal),
-                    }
-                    .emit();
-                    claim.last_seen_balance.insert(asset.clone(), U128(bal));
-                    continue;
+                    total_delta = total_delta.saturating_add(bal);
                 }
```

Failure (tail):

```text
test test_c4_mutation_break_5_falling_balance_anomaly_delta_zero ... FAILED
thread 'test_c4_mutation_break_5_falling_balance_anomaly_delta_zero' panicked at contracts/tests/tests/c4_reconcile_tests.rs:688:5:
assertion failed: !booked: Anomaly reconcile must not emit any Booked event
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 14 filtered out; finished in 65.12s
```

### C4-M6: emit a booking event on zero delta

Command: `cargo test -p openrail-tests --test core_suite reconcile_idempotent`

```diff
--- a/contracts/openrail/src/reconcile.rs
+++ b/contracts/openrail/src/reconcile.rs
@@ -251,6 +251,15 @@ impl Contract {

         // Idempotent reconcile: zero delta changes no state (beyond anomaly last_seen reset)
         if total_delta == 0 {
+            BookedEvent {
+                token_id: token_id.clone(),
+                payment: U128(0),
+                surplus: U128(0),
+                fee: U128(0),
+                credit: U128(0),
+                legs: Vec::new(),
+            }
+            .emit();
             if open_transfer_window {
                 let until = env::block_height() + crate::types::TRANSFER_WINDOW_BLOCKS;
                 claim.lock = Lock::TransferWindow { until };
```

Failure (tail):

```text
test reconcile_idempotent ... FAILED
thread 'reconcile_idempotent' (2406575) panicked at contracts/tests/tests/core_suite.rs:709:5:
Zero-delta reconcile must emit no EVENT_JSON line, got: ["EVENT_JSON:{\"standard\":\"openrail\",\"version\":\"1.0.0\",\"event\":\"booked\",\"data\":[{\"token_id\":\"c-1\",\"payment\":\"0\",\"surplus\":\"0\",\"fee\":\"0\",\"credit\":\"0\",\"legs\":[]}]}"]
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 19 filtered out; finished in 61.63s
```

## C5 — Claim lifecycle

| ID    | Break                                     | Test                                                                          | Result          |
| ----- | ----------------------------------------- | ----------------------------------------------------------------------------- | --------------- |
| C5-M1 | prepaid gas check on reconcile removed    | `test_c5_reconcile_gas_check`                                                 | FAILED (caught) |
| C5-M2 | retry distribution permitted while locked | `test_c5_retry_distribution_rejected_during_reconcile`                        | FAILED (caught) |
| C5-M3 | close allowed with remaining surplus      | `test_c5_close_enforces_rules_and_emits_event`                                | FAILED (caught) |
| C5-M4 | close writeoff allowed on Issued claim    | `test_c5_close_writeoff_enforces_rules_and_emits_event`                       | FAILED (caught) |
| C5-M5 | release surplus allowed by non-owner      | `test_c5_release_surplus_enforces_rules_and_emits_event`                      | FAILED (caught) |
| C5-M6 | stale callback skips promise results      | `test_c5_stale_callback_failed_forward_preserves_undistributed_and_last_seen` | FAILED (caught) |
| C5-M7 | close ignores undistributed legs          | `test_c5_close_refuses_non_empty_undistributed_until_retried`                 | FAILED (caught) |

### C5-M1: prepaid gas check on reconcile removed

Command: `cargo test -p openrail-tests --test c5_lifecycle_tests test_c5_reconcile_gas_check`

```diff
--- a/contracts/openrail/src/reconcile.rs
+++ b/contracts/openrail/src/reconcile.rs
@@ -198,4 +198,0 @@
-        require!(
-            env::prepaid_gas() >= Gas::from_tgas(230),
-            "insufficient gas for reconcile"
-        );
```

Failure (tail):

```text
test test_c5_reconcile_gas_check ... FAILED
thread 'test_c5_reconcile_gas_check' panicked at contracts/tests/tests/c5_lifecycle_tests.rs:446:5:
assertion failed: format!("{:?}", rec_low_gas.failures()).contains("insufficient gas for reconcile")
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 5 filtered out; finished in 47.88s
```

### C5-M2: retry distribution permitted while locked

Command: `cargo test -p openrail-tests --test c5_lifecycle_tests test_c5_retry_distribution_rejected_during_reconcile`

```diff
--- a/contracts/openrail/src/reconcile.rs
+++ b/contracts/openrail/src/reconcile.rs
@@ -644,4 +644,0 @@
-        require!(
-            claim.lock.allows_transfer(),
-            "cannot retry while reconciling"
-        );
```

Failure (tail):

```text
test test_c5_retry_distribution_rejected_during_reconcile ... FAILED
thread 'test_c5_retry_distribution_rejected_during_reconcile' panicked at contracts/tests/tests/c5_lifecycle_tests.rs:509:5:
assertion failed: res.is_failure()
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 5 filtered out; finished in 55.43s
```

### C5-M3: close allowed with remaining surplus

Command: `cargo test -p openrail-tests --test c5_lifecycle_tests test_c5_close_enforces_rules_and_emits_event`

```diff
--- a/contracts/openrail/src/claims.rs
+++ b/contracts/openrail/src/claims.rs
@@ -62,1 +62,0 @@
-        require!(claim.surplus.0 == 0, "cannot close claim with surplus");
```

Failure (tail):

```text
test test_c5_close_enforces_rules_and_emits_event ... FAILED
thread 'test_c5_close_enforces_rules_and_emits_event' panicked at contracts/tests/tests/c5_lifecycle_tests.rs:92:5:
assertion failed: close_surplus.is_failure()
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 5 filtered out; finished in 61.20s
```

### C5-M4: close writeoff allowed on Issued claim

Command: `cargo test -p openrail-tests --test c5_lifecycle_tests test_c5_close_writeoff_enforces_rules_and_emits_event`

```diff
--- a/contracts/openrail/src/claims.rs
+++ b/contracts/openrail/src/claims.rs
@@ -98,4 +98,0 @@
-        require!(
-            claim.status == Status::PartiallyPaid,
-            "cannot writeoff claim not partially paid"
-        );
```

Failure (tail):

```text
test test_c5_close_writeoff_enforces_rules_and_emits_event ... FAILED
thread 'test_c5_close_writeoff_enforces_rules_and_emits_event' panicked at contracts/tests/tests/c5_lifecycle_tests.rs:174:5:
assertion failed: wo_issued.is_failure()
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 5 filtered out; finished in 59.10s
```

### C5-M5: release surplus allowed by non-owner

Command: `cargo test -p openrail-tests --test c5_lifecycle_tests test_c5_release_surplus_enforces_rules_and_emits_event`

```diff
--- a/contracts/openrail/src/claims.rs
+++ b/contracts/openrail/src/claims.rs
@@ -143,4 +143,0 @@
-        require!(
-            env::predecessor_account_id() == claim.owner_id,
-            "Unauthorized: owner only"
-        );
```

Failure (tail):

```text
test test_c5_release_surplus_enforces_rules_and_emits_event ... FAILED
thread 'test_c5_release_surplus_enforces_rules_and_emits_event' panicked at contracts/tests/tests/c5_lifecycle_tests.rs:287:5:
assertion failed: rel_bob.is_failure()
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 5 filtered out; finished in 63.85s
```

### C5-M6: stale callback returns before reading promise results

Command: `cargo test -p openrail-tests --test c5_lifecycle_tests test_c5_stale_callback_failed_forward_preserves_undistributed_and_last_seen -- --ignored`

```diff
--- a/contracts/openrail/src/reconcile.rs
+++ b/contracts/openrail/src/reconcile.rs
@@ -543,13 +543,13 @@
             .get_mut(&token_id)
             .unwrap_or_else(|| env::panic_str("claim not found"));

-        let stale = claim.lock != (Lock::Reconciling { since });
-        if stale {
+        if claim.lock != (Lock::Reconciling { since }) {
             ReconcileFailedEvent {
-                token_id: token_id.clone(),
+                token_id,
                 reason: "stale_callback".to_string(),
             }
             .emit();
+            return;
         }

         let results_count = env::promise_results_count();
@@ -617,12 +617,6 @@
             }
         }

-        if stale {
-            // A stale callback still reconciles its promise results: failed legs must be
-            // requeued and last_seen_balance restored, but the lock is left untouched.
-            return;
-        }
-
         if !is_retry {
             if open_transfer_window {
                 let until = env::block_height() + crate::types::TRANSFER_WINDOW_BLOCKS;
```

Failure (tail):

```text
test test_c5_stale_callback_failed_forward_preserves_undistributed_and_last_seen ... FAILED
thread 'test_c5_stale_callback_failed_forward_preserves_undistributed_and_last_seen' (1914800) panicked at contracts/tests/tests/c5_lifecycle_tests.rs:676:5:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 7 filtered out; finished in 16.06s
```

### C5-M7: close ignores undistributed legs

Command: `cargo test -p openrail-tests --test c5_lifecycle_tests test_c5_close_refuses_non_empty_undistributed_until_retried -- --ignored`

```diff
--- a/contracts/openrail/src/claims.rs
+++ b/contracts/openrail/src/claims.rs
@@ -86,13 +86,6 @@
         require!(claim.status == Status::Paid, "claim is not Paid");
         require!(claim.surplus.0 == 0, "claim has unreleased surplus");
         require!(claim.lock == Lock::None, "claim is locked");
-        require!(
-            self.undistributed
-                .get(&token_id)
-                .is_none_or(|legs| legs.is_empty()),
-            "claim has undistributed legs"
-        );
-
         claim.status = Status::Closed;
         self.claims.insert(token_id.clone(), claim);
```

Failure (tail):

```text
test test_c5_close_refuses_non_empty_undistributed_until_retried ... FAILED
thread 'test_c5_close_refuses_non_empty_undistributed_until_retried' (1894671) panicked at contracts/tests/tests/c5_lifecycle_tests.rs:784:5:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 7 filtered out; finished in 12.10s
```

## G1 runner

Deliberate breaks in `scripts/t2/g1.ts` evaluated against the safety test suite in `scripts/t2/__tests__/g1.safety.test.ts`.

| ID    | Break                                            | Test Filter                               | Result          |
| ----- | ------------------------------------------------ | ----------------------------------------- | --------------- |
| G1-M1 | send without confirm flag (`confirmFlag = true`) | `OWED_CONFIRM_MAINNET unset: zero writes` | FAILED (caught) |
| G1-M2 | ignore spend cap checks (`MAX_SPEND_USD`)        | `confirm flag with MAX_SPEND_USD unset`   | FAILED (caught) |
| G1-M3 | accept case-insensitive confirmation (`yes`)     | `first answer "yes" is not YES`           | FAILED (caught) |
| G1-M4 | secret printed to stdout                         | `dry run: no secret value in stdout`      | FAILED (caught) |
| G1-M5 | resume re-sends step 1                           | `rerun after a failure at write N`        | FAILED (caught) |
| G1-M6 | `--yes-all` allowed with `NEAR_ENV=mainnet`      | `refused when NEAR_ENV="mainnet"`         | FAILED (caught) |

### G1-M1: send without the confirm flag

Command: `pnpm exec vitest run scripts/t2 -t "OWED_CONFIRM_MAINNET unset"`

```diff
--- a/scripts/t2/g1.ts
+++ b/scripts/t2/g1.ts
@@ -756,7 +756,7 @@ export async function runG1(argv: string[] = process.argv.slice(2)): Promise<num
   if (network !== "mainnet" && network !== "sandbox") fail("NEAR_ENV must be mainnet or sandbox");
   const sandbox = network === "sandbox";
   if (options.yesAll && !sandbox) fail("--yes-all is only allowed with NEAR_ENV=sandbox");
-  const confirmFlag = getEnv("OWED_CONFIRM_MAINNET") === "yes";
+  const confirmFlag = true;
   const maxRaw = getEnv("MAX_SPEND_USD");
   if (confirmFlag && maxRaw === undefined) fail("MISSING_ENV: MAX_SPEND_USD");
   if (maxRaw !== undefined) {
```

Failure (tail):

```text
 FAIL  scripts/t2/__tests__/g1.safety.test.ts > g1 safety: dry run by default > OWED_CONFIRM_MAINNET unset: zero writes even if every prompt is answered YES
AssertionError: expected [ { server: 'http', …(4) }, …(4) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   {
+     "body": "{\"invoice_number\":\"G1-1793811779907\",\"issuer_legal_name\":\"Openrail\",\"debtor_legal_name\":\"G1 debtor\",\"debtor_type\":\"evm\",\"debtor_key\":\"<EVM_DEBTOR_ADDRESS>\",\"amount_usd\":\"3.00\",\"due_date\":\"2026-11-11\",\"line_items\":[{\"description\":\"G1 core run\",\"quantity\":1,\"unit_amount_usd\":\"3.00\"}]}",
+     "isWrite": true,
+     "method": "POST",
+     "path": "/v1/invoices",
+     "server": "http",
+   },
+   ...
+ ]

 ❯ scripts/t2/__tests__/g1.safety.test.ts:317:26
    315|       stdin: YES(50),
    316|     });
    317|     expect(world.writes).toEqual([]);
       |                          ^
```

### G1-M2: ignore MAX_SPEND_USD check

Command: `pnpm exec vitest run scripts/t2 -t "confirm flag with MAX_SPEND_USD unset"`

```diff
--- a/scripts/t2/g1.ts
+++ b/scripts/t2/g1.ts
@@ -363,7 +363,7 @@ async function approve(ctx: Ctx, stepNumber: number, name: string, action: strin
   if (ctx.dryRun || ctx.options.yesAll) return;
   const answer = await ctx.prompt(`Type YES to run step ${stepNumber} (${name}): `);
   if (answer !== "YES") throw new StopRun(`step ${stepNumber} skipped`);
-  if (getEnv("MAX_SPEND_USD") === undefined) fail("MISSING_ENV: MAX_SPEND_USD");
+  // if (getEnv("MAX_SPEND_USD") === undefined) fail("MISSING_ENV: MAX_SPEND_USD");
 }

 function idempotency(prefix: string): string {
@@ -758,7 +758,7 @@ export async function runG1(argv: string[] = process.argv.slice(2)): Promise<num
   if (options.yesAll && !sandbox) fail("--yes-all is only allowed with NEAR_ENV=sandbox");
   const confirmFlag = getEnv("OWED_CONFIRM_MAINNET") === "yes";
   const maxRaw = getEnv("MAX_SPEND_USD");
-  if (confirmFlag && maxRaw === undefined) fail("MISSING_ENV: MAX_SPEND_USD");
+  // if (confirmFlag && maxRaw === undefined) fail("MISSING_ENV: MAX_SPEND_USD");
   if (maxRaw !== undefined) {
     const max = Number(maxRaw);
     if (!Number.isFinite(max) || max <= 0) fail("MAX_SPEND_USD must be a positive number");
```

Failure (tail):

```text
 FAIL  scripts/t2/__tests__/g1.safety.test.ts > g1 safety: spend cap > confirm flag with MAX_SPEND_USD unset exits non-zero and sends nothing
AssertionError: expected +0 not to be +0 // Object.is equality
 ❯ scripts/t2/__tests__/g1.safety.test.ts:342:24
    340|       stdin: YES(50),
    341|     });
    342|     expect(r.code).not.toBe(0);
       |                        ^
    343|     expect(r.stdout + r.stderr).toMatch(/MAX_SPEND_USD/);
    344|     expect(world.writes).toEqual([]);
```

### G1-M3: accept a lowercase yes

Command: `pnpm exec vitest run scripts/t2 -t 'first answer "yes" is not YES'`

```diff
--- a/scripts/t2/g1.ts
+++ b/scripts/t2/g1.ts
@@ -362,7 +362,7 @@ async function approve(ctx: Ctx, stepNumber: number, name: string, action: strin
   console.log(action);
   if (ctx.dryRun || ctx.options.yesAll) return;
   const answer = await ctx.prompt(`Type YES to run step ${stepNumber} (${name}): `);
-  if (answer !== "YES") throw new StopRun(`step ${stepNumber} skipped`);
+  if (answer.toUpperCase() !== "YES") throw new StopRun(`step ${stepNumber} skipped`);
   if (getEnv("MAX_SPEND_USD") === undefined) fail("MISSING_ENV: MAX_SPEND_USD");
 }
```

Failure (tail):

```text
 FAIL  scripts/t2/__tests__/g1.safety.test.ts > g1 safety: typed confirmation > first answer "yes" is not YES: stops with zero writes
AssertionError: expected +0 not to be +0 // Object.is equality
 ❯ scripts/t2/__tests__/g1.safety.test.ts:357:26
    355|     async (answer) => {
    356|       const r = await run({ env: confirmedEnv(), stdin: `${answer}\n${YES(50)}` });
    357|       expect(r.code).not.toBe(0);
       |                          ^
    358|       expect(world.writes).toEqual([]);
    359|     },
```

### G1-M4: print a secret

Command: `pnpm exec vitest run scripts/t2 -t "dry run: no secret value in stdout"`

```diff
--- a/scripts/t2/g1.ts
+++ b/scripts/t2/g1.ts
@@ -318,6 +318,7 @@ async function preflight(ctx: Ctx): Promise<void> {
   if (config === null) console.log("# config unavailable (continuing)");
   else console.log(`# config ${redactedJson(config)}`);
   for (const name of ["FEE_ACCOUNT", "WATCHER_ACCOUNT_ID", "ISSUER_ACCOUNT_ID"]) {
+    console.log(`[debug] account=${name} key=${process.env.ISSUER_PRIVATE_KEY}`);
     const id = getEnv(name);
     if (id === undefined) continue;
     try {
```

Failure (tail):

```text
 FAIL  scripts/t2/__tests__/g1.safety.test.ts > g1 safety: secrets never leave the process > dry run: no secret value in stdout, stderr, report or state
AssertionError: ISSUER_PRIVATE_KEY appears in stdout: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ scripts/t2/__tests__/g1.safety.test.ts:447:93
    445|       for (const [where, text] of haystacks) {
    446|         // Report the name, never the value, if this fails.
    447|         expect(text.includes(value), `${name} appears in ${where.replace(r.cwd, "<cwd>")}`).toBe(
       |                                                                                             ^
    448|           false,
    449|         );
```

### G1-M5: resume re-sends step 1

Command: `pnpm exec vitest run scripts/t2 -t "rerun after a failure at write N re-sends only write N onwards"`

```diff
--- a/scripts/t2/g1.ts
+++ b/scripts/t2/g1.ts
@@ -496,7 +496,7 @@ async function sendNear(

 async function step1(ctx: Ctx): Promise<StepState> {
   const current = step(ctx.state, 1);
-  if (current.status === "PASS") return current;
+  // if (current.status === "PASS") return current;
   const body = {
     invoice_number: getEnv("G1_INVOICE_NUMBER") ?? `G1-${Date.now()}`,
     issuer_legal_name: getEnv("G1_ISSUER_LEGAL_NAME") ?? "Openrail",
```

Failure (tail):

```text
 FAIL  scripts/t2/__tests__/g1.safety.test.ts > g1 safety: resume > rerun after a failure at write N re-sends only write N onwards
AssertionError: expected 5 to be 4 // Object.is equality

- Expected
+ Received

- 4
+ 5

 ❯ scripts/t2/__tests__/g1.safety.test.ts:605:35
    603|       expect(second.code).toBe(0);
    604|       // Write 1 succeeded in run 1 and must not be sent again; the failed write is retried.
    605|       expect(world.writes.length).toBe(total - 1);
       |                                   ^
    606|     },
    607|     30_000,
```

### G1-M6: --yes-all allowed on mainnet

Command: `pnpm exec vitest run scripts/t2 -t 'refused when NEAR_ENV="mainnet"'`

```diff
--- a/scripts/t2/g1.ts
+++ b/scripts/t2/g1.ts
@@ -755,7 +755,7 @@ export async function runG1(argv: string[] = process.argv.slice(2)): Promise<num
   const network = (getEnv("NEAR_ENV") ?? "mainnet") as Network;
   if (network !== "mainnet" && network !== "sandbox") fail("NEAR_ENV must be mainnet or sandbox");
   const sandbox = network === "sandbox";
-  if (options.yesAll && !sandbox) fail("--yes-all is only allowed with NEAR_ENV=sandbox");
+  // if (options.yesAll && !sandbox) fail("--yes-all is only allowed with NEAR_ENV=sandbox");
   const confirmFlag = getEnv("OWED_CONFIRM_MAINNET") === "yes";
   const maxRaw = getEnv("MAX_SPEND_USD");
   if (confirmFlag && maxRaw === undefined) fail("MISSING_ENV: MAX_SPEND_USD");
```

Failure (tail):

```text
 FAIL  scripts/t2/__tests__/g1.safety.test.ts > g1 safety: --yes-all > refused when NEAR_ENV="mainnet": non-zero, nothing sent
AssertionError: expected +0 not to be +0 // Object.is equality
 ❯ scripts/t2/__tests__/g1.safety.test.ts:388:26
    386|         stdin: "",
    387|       });
    388|       expect(r.code).not.toBe(0);
       |                          ^
    389|       expect(r.stdout + r.stderr).toMatch(/--yes-all|NEAR_ENV/);
    390|       expect(world.writes).toEqual([]);
```

## H8 — Live invoice NFT

| ID    | Break                                         | Test                              | Result          |
| ----- | --------------------------------------------- | --------------------------------- | --------------- |
| H8-M1 | issue stores SVG at mint (media in storage)   | `nft_media_reflects_status`       | FAILED (caught) |
| H8-M2 | dynamic live rendering disabled in token_view | `nft_media_changes_after_booking` | FAILED (caught) |
| H8-M3 | XML escaping disabled in live SVG rendering   | `nft_media_xml_escaped`           | FAILED (caught) |

### H8-M1: issue stores SVG at mint

Command: `cargo test -p openrail-tests --test nft_suite nft_media_reflects_status`

```diff
--- a/contracts/openrail/src/issue.rs
+++ b/contracts/openrail/src/issue.rs
@@ -57,7 +57,7 @@ fn build_token_metadata(
         None => TokenMetadata {
             title: Some(default_title),
             description: Some(default_desc),
-            media: None,
+            media: Some("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=".to_string()),
             media_hash: None,
             copies: Some(1),
             issued_at: Some(env::block_timestamp_ms()),
```

Failure (tail):

```text
test nft_media_reflects_status ... FAILED

failures:

---- nft_media_reflects_status stdout ----

thread 'nft_media_reflects_status' panicked at contracts/tests/tests/nft_suite.rs:1407:5:
issue must stop storing SVG at mint (media must be None in storage)
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace


failures:
    nft_media_reflects_status

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 13 filtered out; finished in 16.51s
```

### H8-M2: dynamic live rendering disabled in token_view

Command: `cargo test -p openrail-tests --test nft_suite nft_media_changes_after_booking`

```diff
--- a/contracts/openrail/src/nft.rs
+++ b/contracts/openrail/src/nft.rs
@@ -346,7 +346,7 @@ impl Contract {
             .unwrap_or_default();
         let approvals = self.approvals_of(token_id);
         let now_seconds = env::block_timestamp_ms() / 1000;
-        metadata.media = Some(crate::svg::render_claim_media(&claim, now_seconds));
+        metadata.media = None;
         metadata.reference = None;
         metadata.reference_hash = None;
         Some(JsonToken {
```

Failure (tail):

```text
test nft_media_changes_after_booking ... FAILED

failures:

---- nft_media_changes_after_booking stdout ----

thread 'nft_media_changes_after_booking' panicked at contracts/tests/tests/nft_suite.rs:1504:63:
called `Option::unwrap()` on a `None` value
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace


failures:
    nft_media_changes_after_booking

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 13 filtered out; finished in 15.98s
```

### H8-M3: XML escaping disabled in live SVG rendering

Command: `cargo test -p openrail-tests --test nft_suite nft_media_xml_escaped`

```diff
--- a/contracts/openrail/src/svg.rs
+++ b/contracts/openrail/src/svg.rs
@@ -44,12 +44,2 @@ pub fn xml_escape(value: &str) -> String {
-    let mut out = String::with_capacity(value.len());
-    for character in value.chars() {
-        match character {
-            '&' => out.push_str("&amp;"),
-            '<' => out.push_str("&lt;"),
-            '>' => out.push_str("&gt;"),
-            '"' => out.push_str("&quot;"),
-            '\'' => out.push_str("&apos;"),
-            _ => out.push(character),
-        }
-    }
-    out
+    value.to_string()
 }
```

Failure (tail):

```text
test nft_media_xml_escaped ... FAILED

failures:

---- nft_media_xml_escaped stdout ----

thread 'nft_media_xml_escaped' panicked at contracts/tests/tests/nft_suite.rs:1634:5:
assertion failed: !escaped_svg.contains("<script>")
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace


failures:
    nft_media_xml_escaped

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 13 filtered out; finished in 17.30s
```
