# Introduction

Openrail is how a business gets paid in stablecoins. You send an invoice or open a checkout, your client pays from the chain their money is on, a contract on NEAR books the payment where anyone can check it, and the money reaches you as USDC on the chain you choose.

> [!NOTE]
> These pages are for developers and the curious: how Openrail is built, why it works the way it does, and the contracts and services behind it. If you only want to use the app, read [How it works](/how-it-works) instead.

## Why it exists

A business that bills foreign clients who already hold stablecoins has three problems. The client holds USDT on Solana while the business wants USDC on Base. A payment arrives with no reliable link to the invoice it pays, so someone matches it by hand. And the payment address lives in an email, which is how "please pay our new account" fraud works: about $2.8B was lost to it in the US in 2024 (FBI IC3).

Openrail removes all three at the root:

- **Pay from anything.** The client pays USDC or USDT from NEAR, Base, Arbitrum, Ethereum, Solana, Polygon, Optimism or BNB Chain, or ETH, SOL and NEAR. NEAR Intents swaps it on the way.
- **Matching by construction.** Every invoice gets its own keyless account on NEAR. Money that lands in that account _is_ a payment of that invoice: no memo, no guesswork.
- **An address no one can swap.** The invoice's account is fixed in its terms, and only the Openrail contract moves what lands there, to the invoice's owner.

## What you can build with it

- **Invoices** with line items, due dates, partial payments and a pay link. See [Send an invoice](/docs/invoices).
- **A hosted checkout** for any store, with one API call per order and a signed webhook when it is paid. See [Hosted checkout](/docs/checkout).
- **Store plugins** for [Shopify](/docs/shopify) and [WooCommerce](/docs/woocommerce), proven on two real stores.
- **Payouts** to the chain you choose, on your schedule, or into a [confidential balance](/docs/confidential-balance) only you can see.
- **Records** that prove themselves: [receipts and statements](/docs/receipts) with explorer links and fingerprints.
- **Integrations** over a REST API with [signed webhooks](/docs/webhooks), a [CLI and SDK](/docs/cli-sdk), and an [MCP server](/docs/agents) for AI agents.

## Where to start

- New here: read [How a payment works](/docs/how-a-payment-works), then the [Quickstart](/docs/quickstart).
- Building a store integration: [Hosted checkout](/docs/checkout) and [Webhooks](/docs/webhooks).
- Checking the claims: [Live deployment](/docs/live), [Verify a payment](/docs/verify) and the [Trust model](/docs/trust).
- Reading the code: the [Architecture overview](/docs/architecture) and the [Repository map](/docs/repository).

## Status

Openrail runs on NEAR mainnet. The contract `openrail.near` has booked real payments from real stores; the [Proof page](/proof) lists them, newest first, with explorer links. What the build does not do yet is listed plainly in [Limitations](/docs/limitations).
