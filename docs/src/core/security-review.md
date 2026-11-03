# Security review checklist run (Blueprint §3.4)

This document records the independent security review for Openrail core contracts (C1–C5 on `main`),
conducted by an independent reviewer who did not author the contract code, as mandated by
Blueprint §3.4.

All references to files, functions, lines, error constants, and test cases below correspond to
real code in the repository and are validated via `scripts/check-doc-refs.ts`.

---

## 1. Review summary and status

| #     | Checklist Item                                                                  | Status on `main` | Primary Implementation                                      | Covering Acceptance Tests                                                                                                   |
| :---- | :------------------------------------------------------------------------------ | :--------------- | :---------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| **1** | Every `forward` receiver is owner, registered module receiver, or `fee_account` | **PASS**         | `contracts/openrail/src/reconcile.rs`, `claims.rs`          | `distribution_to_holder_or_beneficiary`, `fee_bounded`, `test_c5_release_surplus_enforces_rules_and_emits_event`            |
| **2** | Every callback checks `env::predecessor == current_account` and promise result  | **PASS**         | `lib.rs`, `issue.rs`, `nft.rs`, `reconcile.rs`              | `nft_transfer_call_refund_restores_owner`, `test_c5_release_surplus_nonexistent_receiver_fails_to_undistributed`            |
| **3** | No path where booking is double-counted (`last_seen_balance`, failed legs)      | **PASS**         | `contracts/openrail/src/reconcile.rs`, `claims.rs`          | `reconcile_idempotent`, `test_c4_reconcile_idempotent_zero_delta`, `test_c5_release_surplus_enforces_rules_and_emits_event` |
| **4** | Every lock has an expiry                                                        | **PASS**         | `contracts/openrail/src/types.rs`, `reconcile.rs`, `nft.rs` | `no_transfer_under_lock`, `stale_reconcile_lock_clears`, `test_c5_retry_distribution_rejected_during_reconcile`             |
| **5** | Panic messages leak nothing                                                     | **PASS**         | `lib.rs`, `ack.rs`, `nft.rs`, `issue.rs`, `claims.rs`       | `ack_high_s_rejected`, `test_c1_mutation_break_3_unauthorized_issuer`, `test_c5_reconcile_gas_check`                        |
| **6** | Every allow-listed role has exactly the methods in §1.6                         | **PASS**         | `contracts/openrail/src/issue.rs`, `claims.rs`, `lib.rs`    | `test_c1_mutation_break_3_unauthorized_issuer`, `test_c1_mutation_break_5_unauthorized_quote_writer`                        |
| **7** | 1-yocto rule enforced on every NEP-171/178 state change                         | **PASS**         | `contracts/openrail/src/nft.rs`                             | `nft_transfer_requires_one_yocto`, `nft_transfer_rules_enforced`                                                            |
| **8** | Storage deposits are refunded in excess                                         | **PASS**         | `contracts/openrail/src/issue.rs`                           | `test_c1_excess_deposit_refunded`, `test_c1_storage_credits_and_issue_for`                                                  |

---

## 2. Item-by-item analysis

### Item 1: Forward receiver allow-list

- **Requirement**: Every settlement forward issued by the claim vault subaccount `c-<n>.<root>` must send value exclusively to the claim token owner (`claim.owner_id`), a registered module receiver (`hooks::registered_hooks`), or the protocol `fee_account`.
- **Implementation in Code**:
  - `contracts/openrail/src/reconcile.rs`:
    - Lines 218 & 291: Protocol fee leg is pushed to `fee_account` (`self.config.fee_account`) with amount calculated via `crate::FEE_BPS` (25 bps / 0.25%, lines 283–286).
    - Line 289: Net distribution legs are dispatched via `crate::hooks::dispatch_split_distribution(claim, U128(net))`.
  - `contracts/openrail/src/claims.rs`:
    - Lines 136–202 (`internal_release_surplus`): Requires `env::predecessor_account_id() == claim.owner_id` (lines 143–146) and constructs `Leg::Pay { receiver: claim.owner_id.clone(), amount: U128(take), asset: Some(asset.clone()) }` (lines 172–176) before calling `dispatch_distribution_forwards`.
  - `contracts/openrail/src/hooks.rs`:
    - Lines 150–152 (`CoreDefaultHook`): Default distribution generates `vec![Leg::pay(claim.owner_id.clone(), net)]`.
    - Lines 257–273 (`dispatch_split_distribution_with`): If registered module hooks return legs whose sum does not equal net, core falls back to `CoreDefaultHook` and logs an anomaly, preserving value conservation.
  - `contracts/openrail/src/reconcile.rs:434–475` (`dispatch_distribution_forwards`): Formats each `Leg::Pay` into `VaultForwardArgs` and invokes `forward` on `claim_account`.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/core_suite.rs`:
    - `distribution_to_holder_or_beneficiary`: Proves settlement forwards to holder or hook beneficiary.
    - `fee_bounded`: Asserts protocol fee is bounded by 25 bps.
  - `contracts/tests/tests/c4_reconcile_tests.rs`:
    - `test_c4_reconcile_success_usdc`: Proves standard payment settlement forward to creditor.
    - `test_c4_mutation_break_3_exact_fee_25_bps`: Caught when protocol fee deviates from 25 bps.
    - `test_c4_multi_asset_split_legs_60_40`: Proves multi-asset forward distribution across split legs.
  - `contracts/tests/tests/c5_lifecycle_tests.rs`:
    - `test_c5_release_surplus_enforces_rules_and_emits_event`: Verifies `release_surplus` forwards surplus exclusively to `claim.owner_id`.
- **Verdict**: **PASS**. Forward receivers across both `reconcile` and `release_surplus` are restricted to `fee_account`, verified module hook receivers, and `owner_id`.

---

### Item 2: Private callback validation and promise inspection

- **Requirement**: Asynchronous callbacks must be private (`env::predecessor_account_id() == env::current_account_id()`) and verify promise results before committing state changes.
- **Implementation in Code**:
  - `contracts/openrail/src/lib.rs`:
    - Line 165: `on_issue` is annotated with `#[private]`.
    - Line 224: `on_balances` is annotated with `#[private]`.
    - Line 241: `on_distributed` is annotated with `#[private]`.
    - Line 331: `nft_resolve_transfer` is annotated with `#[private]`.
  - In near-sdk, `#[private]` expands to `if env::predecessor_account_id() != env::current_account_id() { env::panic_str("Method is private"); }`.
  - Promise inspection:
    - `contracts/openrail/src/issue.rs:272` (`internal_on_issue`): Checks `env::promise_result_checked(0, 1024).is_ok()`. On failure, deletes preliminary claim and refunds deposit.
    - `contracts/openrail/src/nft.rs:221` (`internal_nft_resolve_transfer`): Inspects promise result via `env::promise_result_checked(0, 1024)`. If failed or returned true, restores prior owner and approvals.
    - `contracts/openrail/src/reconcile.rs:181–203` (`handle_on_balances`): Validates `env::promise_results_count()` and `env::promise_result_checked(0, 4096)`. On failure or deserialization error, calls `restore_lock(claim, prev_lock)` and emits `ReconcileFailedEvent`.
    - `contracts/openrail/src/reconcile.rs:546–618` (`handle_on_distributed`): Enforces `claim.lock == (Lock::Reconciling { since })` (line 546) across initial bookings, `release_surplus`, and `retry_distribution`, then checks `env::promise_result_checked(idx as u64, 4096).is_ok()` (lines 558–559) for each forward leg. On success with `is_surplus == true` (lines 578–588), emits `SurplusReleasedEvent`. On failure (lines 589–617), records the leg in `self.undistributed`, restores `last_seen_balance` (when `!is_retry`), and emits `DistributionFailedEvent`.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/c1_claims_tests.rs`:
    - `test_c1_issue_failure_refunds_and_deletes_claim`: Confirms failed account creation promise rolls back state.
  - `contracts/tests/tests/nft_suite.rs`:
    - `nft_transfer_call_refund_restores_owner`: Confirms failed `nft_on_transfer` triggers owner restore.
    - `nft_transfer_call_receiver_moved_on_no_takeback`: Proves refund is ignored if receiver already moved token.
  - `contracts/tests/tests/c4_reconcile_tests.rs`:
    - `test_c4_d_s8_failed_distribution_never_unbooks`: Confirms failed forward promise preserves booking and stores leg in `undistributed`.
    - `test_c4_stale_callback_double_book_prevented`: Rejects callback if lock or since timestamp changed.
  - `contracts/tests/tests/c5_lifecycle_tests.rs`:
    - `test_c5_release_surplus_nonexistent_receiver_fails_to_undistributed`: Confirms a failed `release_surplus` forward does not emit `surplus_released`, emits `distribution_failed`, restores `last_seen_balance`, and queues the leg in `undistributed`.
- **Verdict**: **PASS**. Callbacks are private and handle failed promises with explicit state rollbacks or D-S8 failure recording.

---

### Item 3: Monotonic balance and double-booking prevention

- **Requirement**: No code path may count a payment more than once. Retried or failed distributions and surplus releases must never double-book revenue or credit.
- **Implementation in Code**:
  - `contracts/openrail/src/reconcile.rs`:
    - Lines 223–250: Monotonic balance delta calculation. For each settlement asset:
      - If `curr_balance < last_seen`: Emits `AnomalyEvent`, resets `last_seen_balance = curr_balance`, and treats delta as 0.
      - If `curr_balance >= last_seen`: `d_i = curr_balance - last_seen`.
    - Lines 253–265: If `total_delta == 0`, opens `TransferWindow` (if `open_transfer_window`) or calls `restore_lock(claim, prev_lock)` and exits without booking mutations.
    - Lines 371–377: `new_last_seen = curr_bal.saturating_sub(forwarded)`. Retains unforwarded surplus in `last_seen_balance` to prevent re-booking on subsequent `reconcile` calls.
    - Lines 589–617 & 638–670: Failed distribution legs are stored into `self.undistributed` and added back to `last_seen_balance` (when `!is_retry`, lines 599–609) so `reconcile` does not treat the unforwarded vault tokens as a new payment delta. `internal_retry_distribution` retries only the stored legs with `is_retry = true` and decrements `last_seen_balance` upon success (`reconcile.rs:567–571`).
  - `contracts/openrail/src/claims.rs`:
    - Lines 154–182 (`internal_release_surplus`): Deducts allocated surplus from `claim.last_seen_balance` per asset, verifies `require!(remaining == 0, "surplus not covered by last_seen balance")` (line 180), zeroes `claim.surplus` (line 182), and routes legs through `dispatch_distribution_forwards` with `is_retry = false, is_surplus = true`. If a forward fails, `handle_on_distributed` (`reconcile.rs:599–609`) restores `last_seen_balance` and queues the leg in `self.undistributed`.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/core_suite.rs`:
    - `reconcile_idempotent`: Proves repeated reconcile calls at same balance produce zero new bookings.
    - `counters_monotonic`: Proves `booked_total` and `distributed_total` counters never decrease.
  - `contracts/tests/tests/c4_reconcile_tests.rs`:
    - `test_c4_reconcile_idempotent_zero_delta`: Zero delta produces no state mutation.
    - `test_c4_reconcile_anomaly_falling_balance`: Falling balance resets last seen without booking.
    - `test_c4_d_s8_failed_distribution_never_unbooks`: Failed distribution keeps booked status.
    - `test_c4_retry_distribution_empty_panics`: Retrying with no undistributed legs panics.
  - `contracts/tests/tests/c5_lifecycle_tests.rs`:
    - `test_c5_release_surplus_enforces_rules_and_emits_event`: Verifies `release_surplus` zeroes `surplus` and prevents double-release.
    - `test_c5_release_surplus_nonexistent_receiver_fails_to_undistributed`: Verifies failed surplus forward queues into `undistributed` without re-enabling `release_surplus`.
- **Verdict**: **PASS**. Incremental accounting prevents double-booking across `reconcile`, `release_surplus`, and `retry_distribution`.

---

### Item 4: Bounded lock duration and expiry enforcement

- **Requirement**: Every concurrency lock on a claim must have an expiry to prevent permanent lockouts, and all money-moving or lifecycle transitions must respect active locks.
- **Implementation in Code**:
  - `contracts/openrail/src/types.rs:364–393`:
    - `Lock::TransferWindow { until: u64 }`: Bounded by `TRANSFER_WINDOW_BLOCKS` (1,800 blocks ≈ 30 min, `types.rs:364`).
    - `Lock::Reconciling { since: u64 }`: Records start block (`reconcile.rs:117`, `reconcile.rs:655`, `claims.rs:185`).
    - `Lock::Module { id: String, until: u64 }`: Bounded by target block height.
  - Lock acquisition and gating across C4 and C5:
    - `internal_reconcile_with_options` (`reconcile.rs:110–119`): Requires `claim.lock.allows_transfer()` and sets `Lock::Reconciling { since: current_block }`.
    - `internal_retry_distribution` (`reconcile.rs:644–657`): Requires `claim.lock.allows_transfer()` (`"cannot retry while reconciling"`) and sets `Lock::Reconciling { since: current_block }`.
    - `internal_release_surplus` (`claims.rs:147 & 185–187`): Requires `claim.lock == Lock::None` (`"claim is locked"`) and sets `Lock::Reconciling { since: current_block }`.
    - `internal_close` (`claims.rs:88`), `internal_close_writeoff` (`claims.rs:115`), `internal_cancel` (`ack.rs:114`), and `apply_credit` (`lib.rs:571`): All require `claim.lock == Lock::None`.
    - `internal_prepare_transfer` (`nft.rs:429–442`): Verifies owner, `lock_allows_transfer`, sellability, and transfer hooks, then calls `internal_reconcile_with_options(token_id, true)` so the `TransferWindow` opens inside `on_balances` (`reconcile.rs:254–261` / `406–413`) or `on_distributed` (`reconcile.rs:621–628`) after reconciliation completes.
  - `contracts/openrail/src/reconcile.rs:673–697` (`internal_clear_stale_lock`):
    - `Reconciling` lock is stale when `current_block.saturating_sub(*since) > 100` (100 blocks).
    - `TransferWindow` and `Module` locks are stale when `current_block >= *until`.
    - Resets lock to `Lock::None` and emits `LockClearedEvent`.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/core_suite.rs`:
    - `no_transfer_under_lock`: Proves transfer is refused when claim is in `Lock::Reconciling`.
    - `stale_reconcile_lock_clears`: Proves `clear_stale_lock` resets lock after 100 blocks.
    - `prepare_transfer_reconciles_then_opens_window`: Proves `prepare_transfer` reconciles first and opens `TransferWindow`.
  - `contracts/tests/tests/c4_reconcile_tests.rs`:
    - `test_c4_clear_stale_lock`: Verifies `clear_stale_lock` resets stale lock and emits `LockClearedEvent`.
    - `test_c4_mutation_break_1_reconcile_locked`: Proves `reconcile` refuses claims under non-transferable lock.
  - `contracts/tests/tests/c5_lifecycle_tests.rs`:
    - `test_c5_retry_distribution_rejected_during_reconcile`: Proves `retry_distribution` panics when claim is in `Lock::Reconciling`.
- **Verdict**: **PASS**. Locks carry deterministic block bounds, gate all lifecycle/distribution actions, and can be cleared permissionlessly when stale.

---

### Item 5: Information leakage in panic messages

- **Requirement**: Error strings and panic messages must be standardized, opaque, and free of sensitive internal memory, stack traces, or keys.
- **Implementation in Code**:
  - `contracts/openrail/src/lib.rs:66–73`: Constant error codes:
    - `ERR_RULE_1_LOCK = "Rule 1: lock must be None or TransferWindow"`
    - `ERR_RULE_2_STATUS = "Rule 2: status must be Issued or PartiallyPaid"`
    - `ERR_RULE_3_ACK_REQUIRED = "Rule 3: unacknowledged claim cannot be sold"`
    - `ERR_RULE_4_ASSIGNMENT_DOC = "Rule 4: assignment document hash required on sale"`
    - `ERR_RULE_5_RECEIVER_NOT_CLAIM = "Rule 5: receiver cannot be claim account"`
    - `ERR_RULE_6_YOCTO_DEPOSIT = "Rule 6: exactly 1 yoctoNEAR required"`
    - `ERR_RULE_7_NOT_SELLABLE = "Rule 7: kind is not sellable"`
    - `ERR_RULE_8_HOOK_REFUSED = "Rule 8: hook transfer check refused"`
  - `contracts/openrail/src/ack.rs:26–35`: Fixed cryptographic error messages:
    - `"BAD_V"`, `"contract wallets: acknowledge from a NEAR account or an EOA"`, `"BAD_SIGNATURE"`, `"claim not found"`, `"claim has no EVM debtor"`.
  - `contracts/openrail/src/claims.rs:82–180`: Static lifecycle guard strings:
    - `"Unauthorized: owner only"`, `"claim is not Paid"`, `"claim has unreleased surplus"`, `"claim is locked"`, `"claim is not PartiallyPaid"`, `"no surplus to release"`, `"surplus not covered by last_seen balance"`.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/ack_suite.rs`:
    - `ack_high_s_rejected`: Validates signature rejection panics with `BAD_SIGNATURE`.
    - `contract_ack_contract_wallet_refused`: Validates refusal message for contract wallet signatures.
  - `contracts/tests/tests/c1_claims_tests.rs`:
    - `test_c1_mutation_break_3_unauthorized_issuer`: Verifies panic on unauthorized issuer.
    - `test_c1_mutation_break_5_unauthorized_quote_writer`: Verifies panic on unauthorized quote writer.
  - `contracts/tests/tests/c5_lifecycle_tests.rs`:
    - `test_c5_reconcile_gas_check`: Verifies `"insufficient gas for reconcile"` static panic.
- **Verdict**: **PASS**. All panic messages are static or bounded rule literals.

---

### Item 6: Allow-listed roles and method scoping

- **Requirement**: Off-chain roles defined in Blueprint §1.6 must only have access to their designated contract methods:
  - `issuer`: `issue_for`, `log_quote`.
  - `watcher`: `reconcile`, `retry_distribution`, `clear_stale_lock`.
  - `owner`: `prepare_transfer`, `close`, `close_writeoff`, `release_surplus`, pre-ack `cancel`.
  - `root`: `set_config`, `pause_issue`, private callbacks.
- **Implementation in Code**:
  - `contracts/openrail/src/issue.rs:176–181`: `issue_for` checks `require!(self.config.issuers.contains(&env::predecessor_account_id()), "Unauthorized issuer")`.
  - `contracts/openrail/src/issue.rs:372–377`: `log_quote` checks `require!(self.config.quote_writers.contains(&env::predecessor_account_id()), "Unauthorized quote writer")`.
  - `contracts/openrail/src/claims.rs:39–44`: `assert_root_only` enforces `env::predecessor_account_id() == env::current_account_id()`, called by `internal_set_config` (`issue.rs:414`) and `internal_pause_issue` (`issue.rs:476`).
  - `contracts/openrail/src/claims.rs:82–85, 107–110, 143–146` & `nft.rs:431–434`: `internal_close`, `internal_close_writeoff`, `internal_release_surplus`, and `internal_prepare_transfer` enforce `env::predecessor_account_id() == claim.owner_id`.
  - `contracts/openrail/src/ack.rs:119–150`: `internal_cancel` enforces `caller == claim.owner_id` before acknowledgment, and requires the debtor's co-signature (NEAR debtor caller or EVM EIP-712 `DebtorCosig::Evm` from `claim.owner_id`) after acknowledgment.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/c1_claims_tests.rs`:
    - `test_c1_mutation_break_3_unauthorized_issuer`: Confirms non-issuer cannot call `issue_for`.
    - `test_c1_mutation_break_5_unauthorized_quote_writer`: Confirms non-quote-writer cannot call `log_quote`.
  - `contracts/tests/tests/c5_lifecycle_tests.rs`:
    - `test_c5_close_enforces_rules_and_emits_event`: Confirms non-owner cannot call `close`.
    - `test_c5_close_writeoff_enforces_rules_and_emits_event`: Confirms non-owner cannot call `close_writeoff`.
    - `test_c5_release_surplus_enforces_rules_and_emits_event`: Confirms non-owner cannot call `release_surplus`.
- **Verdict**: **PASS**. Method access controls strictly enforce Blueprint §1.6 and §2.2 role matrices.

---

### Item 7: 1-yoctoNEAR attached deposit for NEP-171/178 mutations

- **Requirement**: Security-sensitive state mutations on NFT tokens and approval allowances must require exactly 1 yoctoNEAR attached deposit.
- **Implementation in Code**:
  - `contracts/openrail/src/nft.rs`:
    - Lines 76–79 (`assert_transfer_rules`): `require!(env::attached_deposit().as_yoctonear() == 1, crate::ERR_RULE_6_YOCTO_DEPOSIT)`. Called by `internal_nft_transfer` (line 151) and `internal_nft_transfer_call` (line 168).
    - Lines 287–290 (`internal_nft_revoke`): `require!(env::attached_deposit().as_yoctonear() == 1, crate::ERR_RULE_6_YOCTO_DEPOSIT)`.
    - Lines 303–306 (`internal_nft_revoke_all`): `require!(env::attached_deposit().as_yoctonear() == 1, crate::ERR_RULE_6_YOCTO_DEPOSIT)`.
    - Lines 269–272 (`internal_nft_approve`): `require!(env::attached_deposit().as_yoctonear() >= 1, "Requires attached deposit of at least 1 yoctoNEAR")`.
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
    Lines 349–368 (`internal_withdraw_storage_credit`): Allows withdrawing unused storage credits at any time via `promise_batch_action_transfer`.
- **Covering Tests in Repository**:
  - `contracts/tests/tests/c1_claims_tests.rs`:
    - `test_c1_excess_deposit_refunded`: Tests that excess attached deposit during direct issuance is returned.
    - `test_c1_storage_credits_and_issue_for`: Tests withdrawal of unused prepaid storage credits.
- **Verdict**: **PASS**. Excess storage deposits are calculated and refunded in `on_issue`.

---

## 3. Resolution of C1–C4 findings and new C5 review findings

### Resolved in C5: Lock concurrency in `internal_retry_distribution` (formerly Finding 1)

- **File & Line**: `contracts/openrail/src/reconcile.rs:546` & `638–670`
- **Resolution**: `internal_retry_distribution` now enforces `require!(claim.lock.allows_transfer(), "cannot retry while reconciling")` (lines 644–647), transitions `claim.lock` to `Lock::Reconciling { since: current_block }` (lines 655–657), and passes `prev_lock` and `current_block` into `dispatch_distribution_forwards`. In `handle_on_distributed` (line 546), the stale-callback check `if claim.lock != (Lock::Reconciling { since })` is enforced unconditionally for both normal distributions and retries.
- **Covering Test**: `contracts/tests/tests/c5_lifecycle_tests.rs:474` (`test_c5_retry_distribution_rejected_during_reconcile`).

### Resolved in C5: Gas precondition check on `internal_reconcile` (formerly Finding 2)

- **File & Line**: `contracts/openrail/src/reconcile.rs:100–103`
- **Resolution**: `internal_reconcile_with_options` now asserts `require!(env::prepaid_gas() >= Gas::from_tgas(230), "insufficient gas for reconcile")` before mutating lock state or scheduling cross-contract calls.
- **Covering Test**: `contracts/tests/tests/c5_lifecycle_tests.rs:436` (`test_c5_reconcile_gas_check`).

---

### C5 Finding 1: Upfront state removal in `internal_retry_distribution` and `internal_release_surplus` under stale-callback abort

- **File & Line**: `contracts/openrail/src/reconcile.rs:546–553` & `649`, `contracts/openrail/src/claims.rs:167–182`
- **Scenario**:
  1. `internal_retry_distribution` (`reconcile.rs:649`) removes all pending legs from `self.undistributed` before scheduling `vault.forward` promises.
  2. `internal_release_surplus` (`claims.rs:167–182`) decrements `claim.last_seen_balance` and sets `claim.surplus = U128(0)` before scheduling `vault.forward` promises.
  3. In `handle_on_distributed` (`reconcile.rs:546–553`), if `claim.lock != (Lock::Reconciling { since })` (for example, if `clear_stale_lock` was called after 100 blocks due to cross-shard receipt delay) or if `on_distributed` panics before completing its loop, `handle_on_distributed` emits `ReconcileFailedEvent` and returns early at line 552 without inspecting promise results or re-queuing failed legs into `self.undistributed`. If any `vault.forward` promise failed during that window, its leg is neither in `self.undistributed` nor reflected in `claim.surplus`.
- **Severity**: **Low** (requires a >100-block cross-contract receipt delay combined with a concurrent `clear_stale_lock` call and a failing vault forward).
- **Mitigation / Proposed Hardening**: Even when `claim.lock != (Lock::Reconciling { since })` in `handle_on_distributed` (`reconcile.rs:546`), still inspect `env::promise_result_checked` for each leg and push any failed leg back into `self.undistributed` (and restore `last_seen_balance` when `!is_retry`), skipping only the final `restore_lock` mutation.

### C5 Finding 2: Retried surplus leg does not emit `SurplusReleasedEvent` on eventual success

- **File & Line**: `contracts/openrail/src/claims.rs:172–176`, `contracts/openrail/src/reconcile.rs:578–588` & `660–669`
- **Scenario**: When `internal_release_surplus` dispatches forwards, it sets `is_surplus = true` (`claims.rs:200`). If a forward leg fails (e.g., receiver error), `handle_on_distributed` pushes the `Leg::Pay` into `self.undistributed` (`reconcile.rs:597`) and emits `DistributionFailedEvent` without emitting `SurplusReleasedEvent` (verified by `test_c5_release_surplus_nonexistent_receiver_fails_to_undistributed`). When `internal_retry_distribution` later retries `self.undistributed` (`reconcile.rs:660–669`), it passes `is_surplus = false` (line 668) because `Leg::Pay` does not distinguish booking legs from surplus legs. On retry success, `DistributedEvent` is emitted (`reconcile.rs:572`) and funds reach the owner, but `SurplusReleasedEvent` (`reconcile.rs:578`) is not emitted.
- **Severity**: **Low / Informational** (funds and `DistributedEvent` are delivered accurately; only the secondary `surplus_released` NEP-297 event is omitted on the retry path).

### C5 Finding 3: `internal_close` permits closing a `Paid` claim while `undistributed` legs remain pending

- **File & Line**: `contracts/openrail/src/claims.rs:75–94`
- **Scenario**: `internal_close` checks `claim.status == Status::Paid` (line 86), `claim.surplus.0 == 0` (line 87), and `claim.lock == Lock::None` (line 88), but does not check whether `self.undistributed.get(&token_id)` is empty. Because `internal_release_surplus` zeroes `claim.surplus` prior to forwarding (`claims.rs:182`) and `handle_on_distributed` restores `claim.lock = Lock::None` even when a forward fails (`reconcile.rs:630`), an owner can call `close` while failed booking or surplus legs sit in `self.undistributed`.
- **Severity**: **Low / Informational**.
- **Mitigation**: `internal_retry_distribution` (`reconcile.rs:638–670`) does not restrict execution by `claim.status`, and `closed_addresses_stay_live` (`contracts/tests/tests/core_suite.rs`) ensures closed claim vaults and retry pumps remain live after `Status::Closed`.

### C5 Finding 4: Invariant D-S8 payee preservation across token transfers and surplus release

- **File & Line**: `contracts/openrail/src/reconcile.rs:590–617` & `638–670`, `contracts/openrail/src/claims.rs:172–176`
- **Scenario**: Both booking distributions (`reconcile.rs:352–356`) and surplus releases (`claims.rs:172–176`) bind `receiver` inside `Leg::Pay` at the time of dispatch. If a forward leg fails and is queued into `self.undistributed`, `internal_retry_distribution` dispatches the retry to the recorded `receiver` inside the stored `Leg::Pay`.
- **Severity**: **Informational (Verified Invariant)**.
- **Verification**: Conforms strictly to Invariant D-S8; covered by `contracts/tests/tests/ds8_suite.rs:179` (`undistributed_payee_fixed_at_booking`) and `contracts/tests/tests/c5_lifecycle_tests.rs:329` (`test_c5_release_surplus_nonexistent_receiver_fails_to_undistributed`).
