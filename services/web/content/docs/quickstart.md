# Quickstart

Take your first stablecoin payment in about ten minutes: create an API key, open a checkout, send the payer to the pay page, and hear about the payment on your server.

## 1. Get an API key

Sign in at [openrail.incepture.dev/app](/app) with a NEAR wallet (Meteor, HOT, Here, Nightly, Intear, NEAR Mobile or OKX). Signing in is one signed message: it costs nothing and moves nothing.

Open **API Integration → API keys** and create a secret key. It is shown once. A store integration needs the scopes `invoices:read` and `invoices:write`.

```bash Shell
export API=https://api.openrail.incepture.dev
export OPENRAIL_SECRET_KEY=or_sk_live_...
```

> [!WARNING]
> The secret key belongs on your server. Never put it in a browser, a mobile app or a repository.

## 2. Create a checkout

One call per order. The amount is in US dollars. The same `order_ref` returns the same checkout, so a retry never creates a second one.

```bash curl
curl -s -X POST "$API/v1/checkouts" \
  -H "Authorization: Bearer $OPENRAIL_SECRET_KEY" \
  -H "Idempotency-Key: order-1042" \
  -H "content-type: application/json" \
  -d '{"order_ref":"1042","amount_usd":"48.50","expires_in_minutes":30,
       "return_url":"https://shop.example/thanks"}'
```

The answer carries the hosted pay page:

```json Response (201)
{
  "id": "acme-3f2a9c41d07b",
  "pay_url": "https://openrail.incepture.dev/c/acme-3f2a9c41d07b",
  "claim_account": "acme-3f2a9c41d07b.openrail.near",
  "status": "pending",
  "expires_at": "2026-11-14T19:30:00Z"
}
```

## 3. Send the payer to `pay_url`

The payer picks a coin and a chain, sees the exact price, and pays from a connected wallet or sends from an exchange to a one-time deposit address. Nothing else is needed on your side.

## 4. Hear when it is paid

In **API Integration → Webhooks**, add your endpoint and subscribe to `checkout.paid`. Copy the signing secret (it starts with `whsec_`). Check every delivery before you trust it:

```ts Node.js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody: string, header: string, secret: string): boolean {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  return fresh && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

When `event.type` is `checkout.paid`, mark the order `data.order_ref` as paid. The [Webhooks](/docs/webhooks) guide covers retries, the other events and the payload.

## 5. Check it yourself

Every payment is booked by the contract `openrail.near` on NEAR mainnet. Read the checkout any time, or open the booking on the explorer:

```bash curl
curl -s "$API/v1/checkouts/acme-3f2a9c41d07b" \
  -H "Authorization: Bearer $OPENRAIL_SECRET_KEY"
```

## Next

- Invoices instead of checkouts: [Send an invoice](/docs/invoices).
- Every route: [Endpoints](/docs/endpoints).
- A store without code: [Shopify](/docs/shopify) or [WooCommerce](/docs/woocommerce).
