# Overview

Openrail is one contract on NEAR, a handful of small services around it, and NEAR Intents to move value between chains. This page is the map; each part has its own page.

## Three layers

1. **The contract** `openrail.near` holds the claims, their NFT, the payment log and the payment rules. It is hand-written NEP-171/177/178/181 and builds with `cargo near build` for mainnet protocol 86. See [The contract](/docs/contract).
2. **Off-chain services** prepare transactions, watch for payments, index events and serve the API and the web app. None of them holds a business's money. See [Services](/docs/services).
3. **NEAR Intents** (through its 1Click service) swaps the payer's coin on their chain into USDC on NEAR and delivers it to the invoice's account, and later sends payouts to the business's chain.

## The path of a payment

```text Flow
payer's chain ──(1Click quote, deposit address)──► NEAR Intents
NEAR Intents ──(USDC)──► <business>-<ref>.openrail.near   (the invoice's own account)
watcher ──(reconcile)──► openrail.near ──(booked event, owner's share)──► owner on intents.near
payout worker ──(settle_payout, quote to the owner's destination)──► USDC on the owner's chain
indexer ──(events)──► API ──► dashboard, receipts, statements, webhooks
```

## Design rules

- **Matching is structural.** A payment is identified by the account it lands in, never by a memo or an amount.
- **No custody.** The money sits in the invoice's account, then belongs to its owner on `intents.near`. Service accounts hold NEAR for gas; the API holds no NEAR key.
- **Anyone can finish the job.** `reconcile` is permissionless: if every Openrail service stopped, a payment could still be booked by hand.
- **Off means absent.** Optional features are [modules](/docs/modules): a module that is switched off is not in the contract, the app, the CLI or the docs.
- **Mainnet platform rules.** Protocol 86 means `env::promise_*` only: no `near_sdk::Promise`, no `Self::ext`, no `near-contract-standards`. A wasm import check runs before any contract is handed over.

## Data

- API keys are stored as SHA-256 hashes, scoped to one business, shown once.
- Dashboard sessions are NEP-413 sign-ins, stored hashed, with a 7-day sliding cookie capped at 30 days.
- Idempotency entries live for 24 hours.
- The client's address and the line items are kept with the invoice off chain; the line items' hash is in the terms.
- Receipts, statements and events are read from the indexer, which reads the chain.
