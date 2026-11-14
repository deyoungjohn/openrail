# Live deployment

Everything Openrail runs in production, with the addresses you can check yourself.

## Contract

| What             | Where                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Root contract    | [`openrail.near`](https://nearblocks.io/address/openrail.near) on NEAR mainnet                    |
| Invoice accounts | `<business>-<ref>.openrail.near`, one per invoice or checkout (older ones: `c-<n>.openrail.near`) |
| Settlement       | USDC held for the invoice's owner on `intents.near` (NEAR Intents)                                |

## Services

| Service                  | Address                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| Web app and hosted pages | [openrail.incepture.dev](https://openrail.incepture.dev)                 |
| REST API                 | `https://api.openrail.incepture.dev`                                     |
| OpenAPI 3.1 document     | [`/v1/openapi.json`](https://api.openrail.incepture.dev/v1/openapi.json) |
| Proof data (public)      | [`/proof.json`](/proof.json), the [Proof page](/proof)                   |
| How it works, for agents | [`/how-it-works.md`](/how-it-works.md), [`/llms.txt`](/llms.txt)         |

## Demo stores

Both stores belong to Belmonte Apparels, the developer's own demo business, run to prove the technology works with real money.

| Store       | Address                                                                    | Access                                                        |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| WooCommerce | [belmonte.incepture.dev](https://belmonte.incepture.dev)                   | Open to anyone                                                |
| Shopify     | [belmonte-apparels.myshopify.com](https://belmonte-apparels.myshopify.com) | A development store: the storefront password is in the README |

## Real payments

The [Proof page](/proof) reads the demo business's transactions from the API every minute: invoices and checkouts opened, payments booked, late payments refunded. Each row links to the transaction on NearBlocks. Two examples from the stores:

- A $28.00 Shopify order paid in **USDT on BNB Chain**, booked on NEAR.
- A $48.50 WooCommerce order paid in **USDC on Arbitrum**, booked on NEAR, and completed by the store from the signed webhook.

In both cases the business received USDC: the payer's coin and chain change nothing for the merchant.
