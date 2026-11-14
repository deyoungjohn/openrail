# Trust model

What you have to trust to use Openrail, and what reduces each risk in this build. Stated plainly, including the parts that are not trustless yet.

## Assumptions

| #   | You trust                                                        | Why it is bounded                                                                                                                                      |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | NEAR Intents (1Click) delivers and refunds as quoted             | Amounts are booked only from the claim account's public balance, never from the provider's word. Receipts link the payer's transaction and the booking |
| T2  | The `intents.near` verifier contract                             | Deployed by NEAR Intents, not by Openrail; not independently audited by Openrail                                                                       |
| T3  | The watcher is running                                           | If it stops, bookings wait; nothing is lost. `reconcile` is permissionless, and `clear_stale_lock` frees a lock after its deadline                     |
| T4  | The root contract's code                                         | Open source. This build uses a non-reproducible wasm; a reproducible build is not done yet                                                             |
| T5  | The legal effect of the invoice clauses                          | Untested; counsel is needed. The terms and their fingerprint are on chain                                                                              |
| T6  | The issuer service creates invoices for API callers              | Its key can only call `issue_for` and `log_quote`, and it spends the business's own storage credit or the sponsor pool                                 |
| T7  | The provider keeps the unused price-protection margin on ETH/SOL | Small and stated before paying: "you pay up to X"                                                                                                      |
| T8  | The payout worker sends payouts                                  | It checks the quote's recipient equals the owner's registered destination before sending, never re-sends an in-flight payout, and holds gas only       |

## What Openrail can and cannot do

- It **cannot** move a business's money anywhere but to that business: the invoice's account obeys only the contract, which pays its owner.
- It **cannot** sign for a business: the web app holds no keys, the API holds no NEAR key, and the MCP server refuses any.
- It **can** delay a booking or a payout by stopping its services; anyone can then book with `reconcile`.
- It **can** upgrade the contract with its root key, until that key is removed or put behind a time lock. Openrail is therefore not trustless today, and does not claim to be.

## Privacy

Bookings are public: the contract's events show each payment to each invoice. Names of buyers and clients are not on chain. The [confidential balance](/docs/confidential-balance) hides the business's balance and withdrawals afterwards, not the bookings.
