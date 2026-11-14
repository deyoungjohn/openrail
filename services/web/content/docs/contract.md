# The contract

`openrail.near` is the only place where money rules live. It is a single Rust contract, hand-written against the NEAR standards, built for mainnet protocol 86.

## What it stores

- **Claims**: one per invoice or checkout, with the terms fingerprint, the amount due, the paid total, the due date, the status, the lock and the owner.
- **The NFT** (NEP-171/177/178/181): one token per claim; the token id is the claim's label.
- **The payment log**: every booking, with its legs and the fee.
- **Storage credit** per business and the shared **sponsor pool**.
- **Settlement destinations** per owner (the settle module).

## Main methods

| Method                                                      | Who may call                                                       | What it does                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `issue_for`                                                 | The issuer service's restricted key                                | Creates a claim, its account and its NFT; spends storage credit or the sponsor pool |
| `log_quote`                                                 | The issuer service                                                 | Records a quote given to a payer (the payment log)                                  |
| `reconcile`                                                 | **Anyone**                                                         | Books whatever reached the claim's account since the last booking                   |
| `acknowledge_near`, `acknowledge_evm`                       | The claim's debtor (NEAR account, or an EIP-712 signature relayed) | Records the client's acknowledgement of the terms                                   |
| `nft_transfer`, `prepare_transfer`                          | The owner                                                          | Moves the right to be paid, under numbered rules                                    |
| `deposit_storage_credit`                                    | Anyone, for themselves                                             | Prepays storage for invoices                                                        |
| `deposit_sponsor_pool`                                      | Anyone                                                             | Funds storage for businesses without credit                                         |
| `set_sponsor_cap`, `withdraw_sponsor_pool`                  | The root account                                                   | Sizes and drains the pool                                                           |
| `claim`, `nft_token`, `sponsor_status`, `storage_credit_of` | Anyone (views)                                                     | Read state                                                                          |

## Reconcile

`reconcile(token_id)` reads the claim account's public balance on `intents.near`, and books the rise since the last booking:

1. lock the claim (no transfer while money moves);
2. split the rise into the fee and the owner's share; book it against the amount due (`PartiallyPaid` or `Paid`; anything above is surplus);
3. credit the owner's share on `intents.near` and emit `booked`;
4. unlock in the callback, which checks every promise result; a stale lock is cleared by `clear_stale_lock` after its deadline.

The balance can only rise by a payment, so booking is monotonic: a payment cannot be booked twice.

## Transfer rules

Inside `nft_transfer`, `nft_transfer_call` and `prepare_transfer`, numbered rules refuse a transfer while a booking is in flight, require exactly 1 yoctoNEAR, clear approvals, and forbid sending the token to its own claim account. A refusal's panic message names the rule.

## Build and checks

```bash Shell
make contract      # cargo near build (non-reproducible wasm in this build)
make wasm-check    # no forbidden host imports for protocol 86
make abi-check     # the ABI matches the committed one
```

The contract is covered by unit, model and sandbox tests, and a mutation check: each rule was broken on purpose and a named test had to fail.

> [!WARNING]
> The contract can be upgraded by its root key. Until that key is removed or put behind a time lock, Openrail is not trustless, and these docs do not claim it is. See the [Trust model](/docs/trust).
