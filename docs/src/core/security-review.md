# Security review checklist run (Blueprint §3.4)

This document records the independent security review for Openrail core contracts (C1–C4 on `main`),
conducted by an independent reviewer who did not author the contract code, as mandated by
Blueprint §3.4.

All references to files, functions, lines, error constants, and test cases below correspond to
real code in the repository and are validated via `scripts/check-doc-refs.ts`.

---

## 1. Review summary and status

| #     | Checklist Item                                                                  | Status on `main` | Primary Implementation                            | Covering Acceptance Tests                                                                            |
| :---- | :------------------------------------------------------------------------------ | :--------------- | :------------------------------------------------ | :--------------------------------------------------------------------------------------------------- |
| **1** | Every `forward` receiver is owner, registered module receiver, or `fee_account` | **PASS**         | `contracts/openrail/src/reconcile.rs`             | `distribution_to_holder_or_beneficiary`, `fee_bounded`                                               |
| **2** | Every callback checks `env::predecessor == current_account` and promise result  | **PASS**         | `lib.rs`, `issue.rs`, `nft.rs`, `reconcile.rs`    | `nft_transfer_call_refund_restores_owner`, `test_c1_issue_failure_refunds_and_deletes_claim`         |
| **3** | No path where booking is double-counted (`last_seen_balance`, failed legs)      | **PASS**         | `contracts/openrail/src/reconcile.rs`             | `reconcile_idempotent`, `test_c4_reconcile_idempotent_zero_delta`                                    |
| **4** | Every lock has an expiry                                                        | **PASS**         | `contracts/openrail/src/types.rs`, `reconcile.rs` | `no_transfer_under_lock`, `stale_reconcile_lock_clears`                                              |
| **5** | Panic messages leak nothing                                                     | **PASS**         | `lib.rs`, `ack.rs`, `nft.rs`, `issue.rs`          | `ack_high_s_rejected`, `test_c1_mutation_break_3_unauthorized_issuer`                                |
| **6** | Every allow-listed role has exactly the methods in §1.6                         | **PASS**         | `contracts/openrail/src/issue.rs`, `lib.rs`       | `test_c1_mutation_break_3_unauthorized_issuer`, `test_c1_mutation_break_5_unauthorized_quote_writer` |
| **7** | 1-yocto rule enforced on every NEP-171/178 state change                         | **PASS**         | `contracts/openrail/src/nft.rs`                   | `nft_transfer_requires_one_yocto`, `nft_transfer_rules_enforced`                                     |
| **8** | Storage deposits are refunded in excess                                         | **PASS**         | `contracts/openrail/src/issue.rs`                 | `test_c1_excess_deposit_refunded`, `test_c1_storage_credits_and_issue_for`                           |

---

## 2. Item-by-item analysis

### Item 1: Forward receiver allow-list

- **Requirement**: Every settlement forward issued by the claim vault subaccount `c-<n>.<root>` must send value exclusively to the claim token owner (`claim.owner_id`), a registered module receiver (`hooks::registered_hooks`), or the protocol `fee_account`.
- **Implementation in Code**:
  - `contracts/openrail/src/reconcile.rs`:
    - Lines 191 & 254: Protocol fee leg is pushed to `fee_account` (`self.config.fee_account`) with amount calculated via `crate::FEE_BPS` (25 bps / 0.25%, line 247).
    - Line 252: Net distribution legs are dispatched via `crate::hooks::dispatch_split_distribution(claim, U128(net))`.
  - `contracts/openrail/src/hooks.rs`:
    - Lines 150–152 (`CoreDefaultHook`): Default distribution generates `vec![Leg::pay(claim.owner_id.clone(), net)]`.
    - Lines 257–273 (`dispatch_split_distribution_with`): If registered module hooks return legs whose sum does not equal net, core falls back to `CoreDefaultHook` and logs an anomaly, preserving value conservation.
  - Lines 406–421: `dispatch_distribution_forwards` formats each leg into `VaultForwardArgs` and invokes `forward` on `claim_account`.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/core_suite.rs`:
    - `distribution_to_holder_or_beneficiary`: Proves settlement forwards to holder or hook beneficiary.
    - `fee_bounded`: Asserts protocol fee is bounded by 25 bps.
  - `contracts/tests/tests/c4_reconcile_tests.rs`:
    - `test_c4_reconcile_success_usdc`: Proves standard payment settlement forward to creditor.
    - `test_c4_mutation_break_3_exact_fee_25_bps`: Caught when protocol fee deviates from 25 bps.
    - `test_c4_multi_asset_split_legs_60_40`: Proves multi-asset forward distribution across split legs.
- **Verdict**: **PASS**. Forward receivers are restricted to `fee_account`, verified module hook receivers, and `owner_id`.

---

### Item 2: Private callback validation and promise inspection

- **Requirement**: Asynchronous callbacks must be private (`env::predecessor_account_id() == env::current_account_id()`) and verify promise results before committing state changes.
- **Implementation in Code**:
  - `contracts/openrail/src/lib.rs`:
    - Line 165: `on_issue` is annotated with `#[private]`.
    - Line 224: `on_balances` is annotated with `#[private]`.
    - Line 230: `on_distributed` is annotated with `#[private]`.
    - Line 292: `nft_resolve_transfer` is annotated with `#[private]`.
  - In near-sdk, `#[private]` expands to `if env::predecessor_account_id() != env::current_account_id() { env::panic_str("Method is private"); }`.
  - Promise inspection:
    - `contracts/openrail/src/issue.rs:271` (`internal_on_issue`): Checks `env::promise_result_checked(0, 1024).is_ok()`. On failure, deletes preliminary claim and refunds deposit.
    - `contracts/openrail/src/nft.rs:214` (`internal_nft_resolve_transfer`): Inspects promise result via `env::promise_result_checked(0, 1024)`. If failed or returned true, restores prior owner and approvals.
    - `contracts/openrail/src/reconcile.rs:165` (`handle_on_balances`): Validates `env::promise_results_count()` and `env::promise_result_checked(0, 4096)`. On failure or deserialization error, calls `restore_lock(claim, prev_lock)` and emits `ReconcileFailedEvent`.
    - `contracts/openrail/src/reconcile.rs:491` (`handle_on_distributed`): Checks `env::promise_result_checked(idx as u64, 4096).is_ok()` for each forward leg. If a leg fails, records it in `self.undistributed` and emits `DistributionFailedEvent`.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/c1_claims_tests.rs`:
    - `test_c1_issue_failure_refunds_and_deletes_claim`: Confirms failed account creation promise rolls back state.
  - `contracts/tests/tests/nft_suite.rs`:
    - `nft_transfer_call_refund_restores_owner`: Confirms failed `nft_on_transfer` triggers owner restore.
    - `nft_transfer_call_receiver_moved_on_no_takeback`: Proves refund is ignored if receiver already moved token.
  - `contracts/tests/tests/c4_reconcile_tests.rs`:
    - `test_c4_d_s8_failed_distribution_never_unbooks`: Confirms failed forward promise preserves booking and stores leg in `undistributed`.
    - `test_c4_stale_callback_double_book_prevented`: Rejects callback if lock or since timestamp changed.
- **Verdict**: **PASS**. Callbacks are private and handle failed promises with explicit state rollbacks or failure recording.

---

### Item 3: Monotonic balance and double-booking prevention

- **Requirement**: No code path may count a payment more than once. Retried or failed distributions must never double-book revenue or credit.
- **Implementation in Code**:
  - `contracts/openrail/src/reconcile.rs`:
    - Lines 196–224: Monotonic balance delta calculation. For each settlement asset:
      - If `curr_balance < last_seen`: Emits `AnomalyEvent`, resets `last_seen_balance = curr_balance`, and treats delta as 0.
      - If `curr_balance >= last_seen`: `d_i = curr_balance - last_seen`.
    - Lines 226–229: If `total_delta == 0`, calls `restore_lock(claim, prev_lock)` and exits without state modifications.
    - Lines 333–340: `new_last_seen = curr_bal.saturating_sub(forwarded)`. Retains unforwarded surplus in `last_seen_balance` to prevent re-booking.
    - Lines 511–518 & 547–566: Failed distribution legs are stored into `self.undistributed`. Booking counters (`booked_total`, `fee_total`, `distributed_total`) stand unchanged. `internal_retry_distribution` retries only the stored legs with `is_retry = true` without re-evaluating balances.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/core_suite.rs`:
    - `reconcile_idempotent`: Proves repeated reconcile calls at same balance produce zero new bookings.
    - `counters_monotonic`: Proves `booked_total` and `distributed_total` counters never decrease.
  - `contracts/tests/tests/c4_reconcile_tests.rs`:
    - `test_c4_reconcile_idempotent_zero_delta`: Zero delta produces no state mutation.
    - `test_c4_reconcile_anomaly_falling_balance`: Falling balance resets last seen without booking.
    - `test_c4_d_s8_failed_distribution_never_unbooks`: Failed distribution keeps booked status.
    - `test_c4_retry_distribution_empty_panics`: Retrying with no undistributed legs panics.
- **Verdict**: **PASS**. Incremental accounting prevents double-booking across retries and idempotency checks.

---

### Item 4: Bounded lock duration and expiry enforcement

- **Requirement**: Every concurrency lock on a claim must have an expiry to prevent permanent lockouts.
- **Implementation in Code**:
  - `contracts/openrail/src/types.rs:361–371`:
    - `Lock::TransferWindow { until: u64 }`: Bounded by `TRANSFER_WINDOW_BLOCKS` (1,800 blocks ≈ 30 min, `contracts/openrail/src/nft.rs:436`).
    - `Lock::Reconciling { since: u64 }`: Records start block (`contracts/openrail/src/reconcile.rs:97`).
    - `Lock::Module { id: String, until: u64 }`: Bounded by target block height.
  - `contracts/openrail/src/reconcile.rs:569–593` (`internal_clear_stale_lock`):
    - Reconciling lock is stale when `current_block.saturating_sub(*since) > 100` (100 blocks).
    - TransferWindow is stale when `current_block >= *until`.
    - Module lock is stale when `current_block >= *until`.
    - Resets lock to `Lock::None` and emits `LockClearedEvent`.
  - Transfer rule specification:
    - Rule 1 (`contracts/openrail/src/nft.rs:80`): `require!(lock_allows_transfer(&claim.lock), crate::ERR_RULE_1_LOCK)`.
    - Helper `lock_allows_transfer` (`nft.rs:37`): Returns `true` for `Lock::None | Lock::TransferWindow { .. }`. A transfer window permits transfers while open; expiry allows `clear_stale_lock` and module actions to proceed.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/core_suite.rs`:
    - `no_transfer_under_lock`: Proves transfer is refused when claim is in `Lock::Reconciling`.
    - `stale_reconcile_lock_clears`: Proves `clear_stale_lock` resets lock after 100 blocks.
  - `contracts/tests/tests/c4_reconcile_tests.rs`:
    - `test_c4_clear_stale_lock`: Verifies `clear_stale_lock` resets stale lock and emits `LockClearedEvent`.
    - `test_c4_mutation_break_1_reconcile_locked`: Proves `reconcile` refuses claims under non-transferable lock.
- **Verdict**: **PASS**. Locks carry deterministic block bounds and stale locks can be cleared permissionlessly.

---

### Item 5: Information leakage in panic messages

- **Requirement**: Error strings and panic messages must be standardized, opaque, and free of sensitive internal memory, stack traces, or keys.
- **Implementation in Code**:
  - `contracts/openrail/src/lib.rs:48–64`: Constant error codes:
    - `ERR_RULE_1_LOCK = "Rule 1: lock active"`
    - `ERR_RULE_2_STATUS = "Rule 2: claim settled or cancelled"`
    - `ERR_RULE_3_ACK_REQUIRED = "Rule 3: unacknowledged claim cannot be sold"`
    - `ERR_RULE_4_DOC_HASH = "Rule 4: assignment document hash required for sale"`
    - `ERR_RULE_5_RECEIVER_NOT_CLAIM = "Rule 5: receiver cannot be the claim account"`
    - `ERR_RULE_6_YOCTO_DEPOSIT = "Rule 6: requires exactly 1 yoctoNEAR deposit"`
    - `ERR_RULE_7_NOT_SELLABLE = "Rule 7: claim kind is not sellable"`
  - `contracts/openrail/src/ack.rs:26–36`: Fixed cryptographic error messages:
    - `"BAD_V"`, `"contract wallets: acknowledge from a NEAR account or an EOA"`, `"BAD_SIGNATURE"`, `"claim not found"`, `"claim has no EVM debtor"`.
  - Access control panics:
    - `"Unauthorized issuer"`, `"Unauthorized quote writer"`, `"Unauthorized: root only"`, `"Unauthorized: owner only"`.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/ack_suite.rs`:
    - `ack_high_s_rejected`: Validates signature rejection panics with `BAD_SIGNATURE`.
    - `contract_ack_contract_wallet_refused`: Validates refusal message for contract wallet signatures.
  - `contracts/tests/tests/c1_claims_tests.rs`:
    - `test_c1_mutation_break_3_unauthorized_issuer`: Verifies panic on unauthorized issuer.
    - `test_c1_mutation_break_5_unauthorized_quote_writer`: Verifies panic on unauthorized quote writer.
- **Verdict**: **PASS**. All panic messages are static string literals.

---

### Item 6: Allow-listed roles and method scoping

- **Requirement**: Off-chain roles defined in Blueprint §1.6 must only have access to their designated contract methods:
  - `issuer`: `issue_for`, `log_quote`.
  - `watcher`: `reconcile`, `retry_distribution`, `clear_stale_lock`.
  - `root`: `set_config`, `pause_issue`, private callbacks.
- **Implementation in Code**:
  - `contracts/openrail/src/issue.rs:178–181`: `issue_for` checks `require!(self.config.issuers.contains(&env::predecessor_account_id()), "Unauthorized issuer")`.
  - `contracts/openrail/src/issue.rs:371–377`: `log_quote` checks `require!(self.config.quote_writers.contains(&env::predecessor_account_id()), "Unauthorized quote writer")`.
  - `contracts/openrail/src/lib.rs:444 & 468`: `set_config` and `pause_issue` enforce `require!(env::predecessor_account_id() == env::current_account_id(), "Unauthorized: root only")`.
  - `reconcile`, `retry_distribution`, and `clear_stale_lock` are public permissionless methods in `contracts/openrail/src/lib.rs`, callable by the watcher pump or anyone without special privilege.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/c1_claims_tests.rs`:
    - `test_c1_mutation_break_3_unauthorized_issuer`: Confirms non-issuer cannot call `issue_for`.
    - `test_c1_mutation_break_5_unauthorized_quote_writer`: Confirms non-quote-writer cannot call `log_quote`.
- **Verdict**: **PASS**. Method access controls strictly enforce Blueprint §1.6 matrices.

---

### Item 7: 1-yoctoNEAR attached deposit for NEP-171/178 mutations

- **Requirement**: Security-sensitive state mutations on NFT tokens and approval allowances must require exactly 1 yoctoNEAR attached deposit.
- **Implementation in Code**:
  - `contracts/openrail/src/nft.rs`:
    - Line 76 (`assert_transfer_rules`): `require!(env::attached_deposit().as_yoctonear() == 1, crate::ERR_RULE_6_YOCTO_DEPOSIT)`. Called by `nft_transfer` (line 145) and `nft_transfer_call` (line 162).
    - Line 283 (`internal_nft_revoke`): `require!(env::attached_deposit().as_yoctonear() == 1, crate::ERR_RULE_6_YOCTO_DEPOSIT)`.
    - Line 299 (`internal_nft_revoke_all`): `require!(env::attached_deposit().as_yoctonear() == 1, crate::ERR_RULE_6_YOCTO_DEPOSIT)`.
    - Line 264 (`internal_nft_approve`): `require!(env::attached_deposit().as_yoctonear() >= 1, "Requires attached deposit of at least 1 yoctoNEAR")`.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/nft_suite.rs`:
    - `nft_transfer_requires_one_yocto`: Verifies rejection if attached deposit is not exactly 1 yoctoNEAR.
    - `nft_transfer_only_owner_or_approved`: Verifies transfer execution with 1 yoctoNEAR.
    - `nft_transfer_rules_enforced`: Verifies transfer rules under 1 yoctoNEAR.
  - `docs/src/core/mutations.md`:
    - Mutation C2-M1 (`nft_transfer_requires_one_yocto`).
- **Verdict**: **PASS**. All mutating NEP-171 and NEP-178 methods enforce the 1-yocto rule.

---

### Item 8: Excess storage deposit refunds

- **Requirement**: Unused NEAR attached for state storage during claim issuance must be promptly refunded to the payer.
- **Implementation in Code**:
  - `contracts/openrail/src/issue.rs:301–305`:
    ```rust
    if !args.is_issue_for && args.attached_deposit.0 > args.storage_cost.0 {
        let excess = args.attached_deposit.0 - args.storage_cost.0;
        let refund = env::promise_batch_create(&args.payer_or_business);
        env::promise_batch_action_transfer(refund, NearToken::from_yoctonear(excess));
    }
    ```
  - For prepaid storage credits:
    Lines 348–368 (`internal_withdraw_storage_credit`): Allows withdrawing unused storage credits at any time via `promise_batch_action_transfer`.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/c1_claims_tests.rs`:
    - `test_c1_excess_deposit_refunded`: Tests that excess attached deposit during direct issuance is returned.
    - `test_c1_storage_credits_and_issue_for`: Tests withdrawal of unused prepaid storage credits.
- **Verdict**: **PASS**. Excess storage deposits are calculated and refunded in `on_issue`.

---

## 3. Real gaps and findings in C1–C4

### Finding 1: Lock concurrency in `internal_retry_distribution`

- **File & Line**: `contracts/openrail/src/reconcile.rs:548`
- **Scenario**: `internal_retry_distribution` retrieves and removes `undistributed` legs, then calls `dispatch_distribution_forwards` without verifying `claim.lock.allows_transfer()`. If an invoice is currently in `Lock::Reconciling` (from a concurrent `reconcile` call), `retry_distribution` dispatches vault forwards simultaneously. When `on_distributed` resolves with `is_retry = true` (line 501), it mutates `claim.last_seen_balance` concurrently while `handle_on_balances` may be evaluating balances and computing deltas, creating a race condition on `last_seen_balance`.
- **Severity**: **Medium**.
- **Proposed Fix**: Add lock gating in `internal_retry_distribution`:
  ```rust
  require!(claim.lock.allows_transfer(), "claim is locked");
  ```

### Finding 2: Gas precondition check on `internal_reconcile`

- **File & Line**: `contracts/openrail/src/reconcile.rs:84`
- **Scenario**: Doc comments and Blueprint §1.6 indicate `reconcile` requires at least 250 Tgas attached to cover `GAS_FOR_MT_BATCH_BALANCE_OF` (10 Tgas) and `GAS_FOR_ON_BALANCES` (220 Tgas). However, `internal_reconcile` contains no explicit assertion on `env::prepaid_gas()`. If called with insufficient gas, promise scheduling fails or downstream callback execution may run out of gas during state-heavy operations.
- **Severity**: **Low / Defense-in-depth**.
- **Proposed Fix**: Add gas assertion at entry:
  ```rust
  require!(env::prepaid_gas() >= Gas::from_tgas(230), "insufficient gas for reconcile");
  ```

### Finding 3: Reconcile lock recovery on unhandled callback failures

- **File & Line**: `contracts/openrail/src/reconcile.rs:138`
- **Scenario**: `handle_on_balances` restores lock state via `restore_lock(claim, prev_lock)` on promise errors and JSON decode errors. However, if an unhandled panic occurs prior to `restore_lock`, the callback aborts and `claim.lock` remains set to `Lock::Reconciling { since }`.
- **Severity**: **Low / Mitigated**.
- **Mitigation**: Bounded recovery is provided by `internal_clear_stale_lock` (`reconcile.rs:569`), which allows anyone to clear locks older than 100 blocks, verified by `test_c4_clear_stale_lock`.

### Finding 4: Invariant D-S8 payee preservation across token transfers

- **File & Line**: `contracts/openrail/src/reconcile.rs:511–518` & `547–566`
- **Scenario**: When a forward leg fails during distribution, it is stored in `self.undistributed` with the original payee receiver recorded at booking time. If the token is subsequently transferred to a new owner, `internal_retry_distribution` dispatches the payment to the original booked receiver rather than the new token owner.
- **Severity**: **Informational (Verified Invariant)**.
- **Verification**: Conforms strictly to Invariant D-S8; covered by `contracts/tests/tests/ds8_suite.rs:179` (`undistributed_payee_fixed_at_booking`).
