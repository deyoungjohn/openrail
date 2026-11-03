# C2/C3 mutation checks

These are deliberate rule breaks applied to the merged contract code, each run against the named acceptance test, then restored. The recorded run is at commit [`cd54fa9`](https://github.com/deyoungjohn/openrail/commit/cd54fa9), based on [`44361a3`](https://github.com/deyoungjohn/openrail/commit/44361a3) (PR [#54](https://github.com/deyoungjohn/openrail/pull/54)); the later C2 window-cleanup commit does not touch these rules.

## Reproduce

```bash
# apply one diff below, then from the repository root:
rm -rf target/near/openrail
NEAR_SANDBOX_BIN_PATH="$HOME/.near/sandbox" cargo test -p openrail-tests --test <suite> <test>
# expected: FAILED, with the listed test failing
git checkout -- contracts/openrail/src
```

The working tree was clean after restoring all ten mutations (`git diff --exit-code` exited 0).

## C2 — NEP-171 transfers

| ID    | Break                               | Test                                  | Result          |
| ----- | ----------------------------------- | ------------------------------------- | --------------- |
| C2-M1 | exact 1 yocto removed               | `nft_transfer_requires_one_yocto`     | FAILED (caught) |
| C2-M2 | ack rule removed                    | `nft_transfer_rules_enforced`         | FAILED (caught) |
| C2-M3 | assignment memo rule removed        | `nft_transfer_rules_enforced`         | FAILED (caught) |
| C2-M4 | claim-account receiver rule removed | `no_self_ownership`                   | FAILED (caught) |
| C2-M5 | approvals not cleared on transfer   | `nft_transfer_only_owner_or_approved` | FAILED (caught) |

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
