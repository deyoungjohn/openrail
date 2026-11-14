<div align="center">

# Openrail

**Get paid in stablecoins from any chain. Every payment is matched to its invoice by construction and booked on NEAR, where anyone can check it.**

[![CI](https://github.com/deyoungjohn/openrail/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/deyoungjohn/openrail/actions/workflows/ci.yml)
[![NEAR](https://img.shields.io/badge/NEAR-mainnet-brightgreen)](https://nearblocks.io/address/openrail.near)
[![contract](https://img.shields.io/badge/contract-openrail.near-orange)](https://nearblocks.io/address/openrail.near)
[![NEAR Intents](https://img.shields.io/badge/settles%20via-NEAR%20Intents-brightgreen)](https://openrail.incepture.dev/docs/settlement)
[![License: MIT](https://img.shields.io/badge/license-MIT-brightgreen)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-red)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-orange)](pnpm-workspace.yaml)
[![rust](https://img.shields.io/badge/rust-1.99.1-orange)](rust-toolchain.toml)
[![protocol](https://img.shields.io/badge/NEAR%20protocol-86-red)](https://openrail.incepture.dev/docs/contract)

[Live app](https://openrail.incepture.dev) · [Docs](https://openrail.incepture.dev/docs) · [Quickstart](https://openrail.incepture.dev/docs/quickstart) · [Proof of real payments](https://openrail.incepture.dev/proof) · [API (OpenAPI 3.1)](https://api.openrail.incepture.dev/v1/openapi.json)

</div>

Openrail is a payment rail for businesses that bill in stablecoins. You send an invoice or open a checkout. Your client pays in what they already hold, USDC or USDT on any of eight chains, or ETH, SOL or NEAR. NEAR Intents swaps it on the way, and a contract on NEAR mainnet books the payment against that one invoice. You receive USDC on the chain you choose, on your schedule, or in a confidential balance that only you can see.

There is no memo to match, no address to copy from an email and no custody. Each invoice gets its own keyless account on NEAR, so money that lands there *is* a payment of that invoice. Only the contract moves it, and only to the invoice's owner. It runs in production today: the [Proof page](https://openrail.incepture.dev/proof) lists real payments from a real Shopify store and a real WooCommerce store, each linked to its transactions on NearBlocks.

> These docs and this README describe what is built and measured. What the build does not do yet is listed plainly in [Limitations](https://openrail.incepture.dev/docs/limitations).

---

## The gap

A business that bills foreign clients who already hold stablecoins runs into three problems:

1. **The coins don't line up.** The client holds USDT on Solana; the business wants USDC on Base. Someone has to bridge and swap, and usually it is the client, who then pays less or gives up.
2. **Payments arrive without their invoice.** A transfer comes in with no reliable link to what it pays, so a person matches amounts and dates by hand, and partial or combined payments make it worse.
3. **The payment address is a target.** It travels in an email or a PDF, which is how "please pay our new account" fraud works. About $2.8B was lost to business email compromise in the US in 2024 (FBI IC3).

Crypto payment tools solve pieces of this. Most hold the money for you, match payments with memos or amounts, or accept only one chain.

## The solution

Openrail removes all three problems at the root:

- **Pay from anything.** The client pays from NEAR, Base, Arbitrum, Ethereum, Solana, Polygon, Optimism or BNB Chain. [NEAR Intents](https://openrail.incepture.dev/docs/settlement) quotes an exact price and swaps into USDC on the way.
- **Matching by construction.** Every invoice is an NFT with its own keyless account, `<business>-<ref>.openrail.near`. A payment is identified by *where it lands*, never by a memo or an amount. See [One account per invoice](https://openrail.incepture.dev/docs/invoice-accounts).
- **An address no one can swap.** The invoice's account is fixed in its terms. The account has no access keys, and only the Openrail contract can move what lands there, to the invoice's owner.
- **No custody.** The money sits in the invoice's account, then belongs to its owner on `intents.near`. Openrail's services hold NEAR for gas only, and the API holds no NEAR key at all.

## What it does

| | |
| --- | --- |
| **Invoices** | Line items, due dates, partial payments and a pay link. The client pays without an account. [Guide](https://openrail.incepture.dev/docs/invoices) |
| **Hosted checkout** | One API call per order, a hosted pay page and a signed webhook when it is paid. Late payments are held for the merchant to accept or refund. [Guide](https://openrail.incepture.dev/docs/checkout) |
| **Store plugins** | A [Shopify](https://openrail.incepture.dev/docs/shopify) app and a [WooCommerce](https://openrail.incepture.dev/docs/woocommerce) plugin, both proven with real money on real stores. |
| **Payouts** | USDC to the chain you choose, on your schedule, or into a [confidential balance](https://openrail.incepture.dev/docs/confidential-balance) on NEAR Intents. Cash out at any time. [Guide](https://openrail.incepture.dev/docs/cash-out) |
| **Records that prove themselves** | Receipts and monthly statements (PDF and CSV) with explorer links and fingerprints. Anyone can [verify a payment](https://openrail.incepture.dev/docs/verify) with one command. |
| **Developer surface** | A REST API with idempotency and scoped keys, [signed webhooks](https://openrail.incepture.dev/docs/webhooks), a [CLI and SDK](https://openrail.incepture.dev/docs/cli-sdk), and an embeddable widget. |
| **AI agents** | An [MCP server](https://openrail.incepture.dev/docs/agents) that lets an agent check payments, fetch receipts, send pay links and prepare invoices. It holds no keys; you sign. |
| **Fees** | 0.25% per booked payment, paid by the business or passed to the client. There is no monthly fee. [Details](https://openrail.incepture.dev/docs/fees) |

## How it works

1. **The business asks to be paid.** It creates an invoice or a checkout. The contract mints it as an NFT and creates a keyless account for it on NEAR.
2. **The client gets a price.** On the hosted pay page the client picks a coin and a chain. The API asks NEAR Intents (through its 1Click service) for an exact quote. The quote's output is USDC sent to the invoice's account, and it comes with a one-time deposit address and a deadline.
3. **The client pays** from a connected wallet (EVM, Solana or NEAR) or from an exchange. NEAR Intents swaps on the way.
4. **The contract books it.** When the money arrives, `reconcile` books it:
   - the invoice moves to `PartiallyPaid` or `Paid`;
   - the fee is taken;
   - an event is written;
   - the business's share is credited to its owner on `intents.near`.

   The watcher calls `reconcile` as soon as the provider reports the deposit. **Anyone else may call it too.**
5. **The business is paid out** on its schedule, to its own destination.

On mainnet the median time from the provider's success to the booking is **30.5 s** ([K12, timed checkouts](evidence/)). Full walkthrough: [How a payment works](https://openrail.incepture.dev/docs/how-a-payment-works).

## Architecture

```text
payer's chain ──(1Click quote, deposit address)──► NEAR Intents
NEAR Intents ──(USDC)──► <business>-<ref>.openrail.near     (the invoice's own keyless account)
watcher ──(reconcile)──► openrail.near ──(booked event, owner's share)──► owner on intents.near
payout worker ──(settle_payout, quote to the owner's destination)──► USDC on the owner's chain
indexer ──(events)──► API ──► dashboard, receipts, statements, webhooks
```

- **The contract** (`openrail.near`, Rust) holds the claims and their NFT, the payment log and the payment rules. It is hand-written NEP-171/177/178/181, built with `cargo near build` for mainnet protocol 86. [The contract](https://openrail.incepture.dev/docs/contract)
- **Services** (TypeScript) do the off-chain work, and none of them holds a business's money:
  - `issuer` prepares invoices;
  - `watcher` books payments;
  - `indexer` reads events;
  - `api` serves the REST API;
  - `payout` sends payouts;
  - `relayer`, `web`, `shopify`, `mcp` and `cli` cover the rest.

  [Services](https://openrail.incepture.dev/docs/services)
- **NEAR Intents** moves value between chains on the way in (the payer's coin to USDC) and on the way out (the payout to the business's chain).
- **Modules** are optional features (`checkout`, `shopify`, `woocommerce`, `settle`, `agent`) declared in [`openrail.modules.json`](openrail.modules.json). A module that is switched off is absent from the contract, the services, the app and the docs, and a leak check enforces it. [Modules](https://openrail.incepture.dev/docs/modules)

Overview: [Architecture](https://openrail.incepture.dev/docs/architecture) · [Trust model](https://openrail.incepture.dev/docs/trust) · [Security](https://openrail.incepture.dev/docs/security)

## What works today

All of this runs on **NEAR mainnet**, at [openrail.incepture.dev](https://openrail.incepture.dev):

- ✅ Invoices and hosted checkouts paid in USDC or USDT from 8 chains (plus ETH, SOL and NEAR on the pay link), booked by `openrail.near`.
- ✅ A **Shopify** store and a **WooCommerce** store taking real payments. Two examples:
  - a $28.00 order paid in USDT on BNB Chain;
  - a $48.50 order paid in USDC on Arbitrum.

  Both were booked on NEAR, and the business received USDC both times.
- ✅ Partial, split and late payments, with late checkouts accepted or refunded by the merchant.
- ✅ Payouts to a chosen chain on a schedule, cash-out at any time, and a confidential balance.
- ✅ Receipts and statements (PDF and CSV), a [live Proof page](https://openrail.incepture.dev/proof) and [`/proof.json`](https://openrail.incepture.dev/proof.json).
- ✅ The REST API, checkout webhooks, CLI, SDK, widget and MCP server.
- ⚠️ `invoice.*` webhooks are listed but not delivered yet (checkout webhooks are). Follow invoices through the API for now.
- ⚠️ The contract is upgradable by its root key, so Openrail is not trustless yet.

Addresses for everything that runs: [Live deployment](https://openrail.incepture.dev/docs/live). The full list of limits: [Limitations](https://openrail.incepture.dev/docs/limitations).

## Engineering decisions

| Decision | Why |
| --- | --- |
| **One keyless account per invoice** | Matching becomes structural: the destination *is* the invoice. There is no memo to forget, and an amount match can't go wrong. The account has no keys, so only the contract can move funds. |
| **Settle through NEAR Intents (1Click)** | One integration covers 8 chains in and many chains out, with exact quotes. A USDC to USDC route measured a 0% spread (K2′). |
| **`reconcile` is permissionless** | A payment never depends on Openrail being up. If every service stopped, anyone could still book a payment by hand. |
| **Hand-written NEP-171/177/178/181, `env::promise_*` only** | Mainnet protocol 86 rejects code that `near_sdk::Promise`, `Self::ext` and `near-contract-standards` generate. Every contract build passes a wasm import check. |
| **Off means absent** | Modules are compiled in or out, not hidden behind flags. Core code never names a module, and CI checks every module set plus "all on". |
| **No custody, no keys in the API** | Service accounts hold NEAR for gas only. API keys are stored as SHA-256 hashes, and dashboard sign-in is a NEP-413 signed message. |
| **Spec first, tests by someone else** | Tests are written from the spec before the code and never weakened. Contract rules are mutation-checked: each rule was broken on purpose, and a named test had to fail. |
| **Every number links to a run** | Measured claims (timing, gas, storage, spreads) come from reports in [`evidence/`](evidence) and [`reports/`](reports). |

## Repository map

| Path | What |
| --- | --- |
| [`contracts/openrail`](contracts/openrail) | The NEAR contract (Rust), with module code in `src/modules` |
| [`contracts/tests`](contracts/tests), [`contracts/model`](contracts/model) | Sandbox tests and model tests |
| [`services/`](services) | `api`, `web`, `issuer`, `watcher`, `indexer`, `payout`, `relayer`, `shopify`, `mcp`, `cli` |
| [`packages/`](packages) | `shared` (routes, 1Click client, env), `api-client` (generated from OpenAPI), `node-sdk` (SDK), `widget`, `react` |
| [`schemas/`](schemas), [`abi/`](abi) | Event and API schemas; the contract ABI, checked in CI |
| [`config/`](config) | Routes and settlement assets |
| [`deploy/`](deploy) | The server pack, systemd units, env templates and Caddy |
| [`docs/src`](docs/src) | Technical docs for each core part and module |
| [`services/web/content/docs`](services/web/content/docs) | The [docs site](https://openrail.incepture.dev/docs), in Markdown |
| [`evidence/`](evidence), [`reports/`](reports) | Measured runs behind every number |
| [`fixtures/`](fixtures) | API and indexer fixtures for the mock and the tests |
| [`openrail.modules.json`](openrail.modules.json) | Which modules are in the build |

More: [Repository map](https://openrail.incepture.dev/docs/repository).

## Canonical demo

Watch it or run it yourself. Every step below happens on mainnet.

1. **Sign in** at [openrail.incepture.dev/app](https://openrail.incepture.dev/app) with a NEAR wallet (Meteor, HOT, Here, Nightly, Intear, NEAR Mobile or OKX). Signing in is one signed message. It costs nothing and moves nothing.
2. **Create an invoice**, open its pay link, and pay it from another wallet in USDC or USDT on any supported chain.
3. **Watch it book.** The pay page moves through *You send*, then *Payment received*, then *Paid out to the business*. The receipt links the payer's transaction and the booking on NearBlocks.
4. **Buy from a store:**
   - [WooCommerce](https://belmonte.incepture.dev) is open to anyone.
   - [Shopify](https://belmonte-apparels.myshopify.com) is a development store. Its storefront password is `<STOREFRONT_PASSWORD>`.

   Choose *Pay with stablecoins* at checkout. The order completes from the signed webhook.
5. **Check it yourself** on the [Proof page](https://openrail.incepture.dev/proof), or with the command printed on any receipt ([Verify a payment](https://openrail.incepture.dev/docs/verify)).

Both stores belong to Belmonte Apparels, the developer's own demo business, run to prove the rail works with real money.

## Run locally

Requirements: Node.js ≥ 22 with pnpm. For the contract you also need Rust 1.99.1 (from `rust-toolchain.toml`) and `cargo-near`. The mock needs no keys.

```bash
git clone https://github.com/deyoungjohn/openrail.git
cd openrail
pnpm install
cp .env.example .env            # variable names only; values are never committed

# terminal 1: the mock API (fixtures, no chain)
MOCK=1 pnpm --filter @openrail/api start

# terminal 2: the web app
pnpm --filter @openrail/web dev
```

Open `http://localhost:3000`. In mock mode, **Sign in** signs in a fixture business, and every page has data.

```bash
make contract     # build the wasm with cargo near
make wasm-check   # check host imports for protocol 86
pnpm gen:modules  # after editing openrail.modules.json
```

Services read configuration only from the environment. A missing secret stops a service with `MISSING_ENV: <NAME>` instead of falling back to a default. More: [Run locally](https://openrail.incepture.dev/docs/run-locally).

## Tests

```bash
make test          # contract unit, model and sandbox suites, then every service
pnpm test          # the TypeScript packages and services
make lint          # rustfmt, clippy, eslint, prettier
make leak-check    # no trace of switched-off modules
make secret-scan   # no secrets in the tree
```

The web app also has Playwright suites:

- `pnpm --filter @openrail/web test:e2e:web` checks screens, states, accessibility, light and dark themes, and 360 px widths.
- `test:e2e:stack` runs the full stack on a NEAR sandbox.

On every pull request, CI:

- builds the contract and checks its wasm imports and ABI;
- runs the core tests;
- builds and tests each module set, and all modules on;
- runs the web e2e suite and checks the deploy scripts;
- runs the leak check and the secret scan.

A merge needs all of them green. More: [Tests and evidence](https://openrail.incepture.dev/docs/testing).

## History

- **Before 1 Nov 2026: design and spikes.** Every risky assumption was tested on mainnet before any product code was written:
  - keyless invoice accounts created from a contract (K1);
  - a transferred claim that pays its new holder (K13);
  - a client's EIP-712 acknowledgement signed with a real wallet (K14);
  - 1Click route spreads (K2′);
  - booking times (K12).

  The reports are in [`evidence/`](evidence).
- **1 to 14 Nov 2026: the build.** The repo started as a skeleton on 1 Nov (`init: evidence, fixtures, module list`). It grew through phase gates:
  1. the interface freeze;
  2. the contract and its G1 scale gate (gas and storage at 1 and 5,000 claims);
  3. the services and the web app;
  4. the modules (checkout, Shopify, WooCommerce, settle, agent), each merged only after passing its own gate.

  Every change landed through a pull request with CI green on every module set.
- **Cut from this build:** two planned modules did not reach their gate. Following *off means absent*, they are not in the code. The Proof page shipped as part of the core site instead.

See the [commit history](https://github.com/deyoungjohn/openrail/commits/main) and the [pull requests](https://github.com/deyoungjohn/openrail/pulls?q=is%3Apr+is%3Amerged).

## License

[MIT](LICENSE)
