# Architecture

Status: **built** unless a sentence says otherwise.

Openrail is three layers:

1. **One contract** (`openrail.near`) holds claims, the NEP-171 token, the payment
   log and the payment rules. It is hand-written NEP-171/177/178/181 and builds
   with `cargo near build` for mainnet protocol 86. **built**
2. **Off-chain services**:
   - `issuer` creates invoices through `issue_for` and writes `log_quote`; it
     holds only the restricted function-call key and spends the business's
     prepaid storage credit. **built**
   - `api` serves the REST contract and hosted pages. It holds no NEAR key; it
     calls the issuer over a local authenticated port. **built**
   - `watcher` reads batched claim balances, reconciles on a rise, retries failed
     distributions and clears stale locks. **built and tested in the sandbox**
   - `indexer` records contract events for history, statements and receipts.
     **built**
   - `web` is the dashboard and the hosted pay, acknowledgement and receipt
     pages. **built**
   - `cli` is the JSON-first command-line client. **built**
3. **NEAR Intents / 1Click** moves value between the payer's chain and the
   claim's public `intents.near` balance. The settlement asset is USDC on NEAR
   unless a route says otherwise. **tested**

## The per-invoice account

At `issue`, the contract creates `c-<n>.<root>`. The account has no access keys.
It obeys only the Openrail contract, which uses `env::promise_*` calls. A credit
to that account is a payment of that invoice; matching is structural, not a memo
or a manual match. **built and tested in the sandbox**

## Claim lifecycle

Claims move through `Issued`, `PartiallyPaid`, `Paid`, `Cancelled` and `Closed`
under the rules in the contract. Locks block transfers while money is moving.
**built and tested**

## Data and keys

- API keys are stored as sha256 hashes, scoped to one business and shown once.
  **built**
- Dashboard sessions are NEP-413 sign-ins stored as sha256 hashes in SQLite,
  with a 7-day sliding cookie capped at 30 days. **built**
- Idempotency entries live for 24 h. **built**
- The web app holds no keys. The API holds no NEAR key; the issuer service holds
  the restricted function-call key. **built**

## Links

- Blueprint §1.1 for the system map, §1.2 contracts, §1.4 hooks, §1.5 platform
  rules, §1.6 services and §1.7 API.
- [`api.md`](api.md) and [`cli.md`](cli.md) for the developer surfaces.
