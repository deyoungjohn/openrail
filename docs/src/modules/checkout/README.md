# Checkout

A checkout turns an order into a short-lived payment account with a hosted page (`/c/<id>`),
signed webhook events, and wallet-signed late-payment handling.

- **Booking latency:** p50 of 30.5 s on mainnet ([K12 Part A](../../../../evidence/K12-partA-2026-10-29T03-15-27Z.json)),
  and 40 s to final in the live payment test ([pay report](../../../../evidence/pay-report-2026-10-31T19-13-15-901Z.json)).
  The hosted page shows **"Payment received, settling"** as soon as the origin transaction is seen.
- **Measured cost:** 0.16% at \$50 and 0.79% at \$10 ([K12 Part B](../../../../evidence/K12-partB-amended-2026-10-29T12-13-42Z.json)).
  ETH and SOL quotes add the up-to-30 bps price-protection margin ([K2' Part B](../../../../evidence/K2prime-partB-2026-10-29T19-11-58Z.json)).
- **Reusable templates:** see [Payment links](./payment-links.md).

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/v1/checkouts` | secret key (`invoices:write`), `Idempotency-Key` required | Issue a checkout claim (expiry 1..60 min, default 15; `order_ref` unique per business and immutable in `terms_hash`) |
| `GET` | `/v1/checkouts` | `invoices:read` | Paged list (`limit`, `cursor`), status read from chain |
| `GET` | `/v1/checkouts/{id}` | `invoices:read` | Single checkout; `status` (`pending`, `partial`, `paid`, `late`, `accepted`, `refunded`, `expired`), `outstanding`, `paid_total` and `surplus` read from the claim on chain |
| `GET` | `/v1/public/checkouts/{id}` | none | Public payload for `/c/<id>` (routes, open sessions, live status; no internal fields) |
| `POST` | `/v1/checkouts/{id}/accept_late` | `invoices:write`, `Idempotency-Key` | Returns `{ receiver_id, method: "accept_late", args: { token_id }, deposit: "0" }` for the merchant's wallet to sign |
| `POST` | `/v1/checkouts/{id}/refund_quote` | `invoices:write`, `Idempotency-Key` | Quotes a 1Click refund to the payer's `refund_to` recorded in the payment log (never from the request) and returns the `refund_late` wallet call |

### Store & plugin API key scopes

The merchant generates an API key in the dashboard under **Settings → API keys**. An integration or e-commerce plugin (such as the WooCommerce store plugin using `OPENRAIL_API_KEY`) requires the following scopes:

- **`invoices:write`**: required by `POST /v1/checkouts` to issue orders (`services/api/src/modules/checkout/checkouts.ts:477`), and by late-payment actions `POST /v1/checkouts/{id}/accept_late` and `POST /v1/checkouts/{id}/refund_quote` (`services/api/src/modules/checkout/checkouts.ts:493`).
- **`invoices:read`**: required by `GET /v1/checkouts/{id}` to poll order status (`services/api/src/modules/checkout/checkouts.ts:507`) and by `GET /v1/checkouts` to list checkouts (`services/api/src/modules/checkout/checkouts.ts:484`).

When creating the key, tick both **`invoices:read`** and **`invoices:write`**. No other scopes are required for store checkouts.

## Events

Webhook events are built only from the indexed contract events, signed like core webhooks, and
deduplicated with `sha256(token_id ‖ booking_seq)`:

| Contract event | Webhook event | Notes |
| --- | --- | --- |
| `checkout_created` | `checkout.created` | Emitted when the checkout is created |
| `checkout_paid` | `checkout.paid` | Full amount booked within expiry (+ 120 s grace) |
| `checkout_partial` | `checkout.partial` | Carries `due`, `received`, `remaining`; never contains the word `paid` |
| `checkout_paid_late` | `checkout.paid_late` | Booked after expiry + grace; held until accepted or refunded |
| `checkout_accepted` | `checkout.accepted` | Merchant accepted a late checkout |
| `checkout_refund_started` | `checkout.refund_started` | Carries `refund_to` and `amount_in` |

## Try it

1. Create a \$1.00 checkout:

```sh
curl -s -X POST "$API/v1/checkouts" \
  -H "Authorization: Bearer $OPENRAIL_SECRET_KEY" \
  -H "Idempotency-Key: demo-ord-1" \
  -H "content-type: application/json" \
  -d '{"order_ref":"ORD-1","amount_usd":"1.00","expires_in_minutes":15,"return_url":"https://shop.example/thanks"}'
```

→ `201` with `id`, `pay_url` (`/c/<id>`), `claim_account`, `expires_at`, and `status: "pending"`.

2. Open `pay_url` in a browser (360 px or desktop, light or dark), pick a network, enter your refund
   address, and pay. Within about 30 s ([K12 Part A](../../../../evidence/K12-partA-2026-10-29T03-15-27Z.json)),
   the page updates to **Paid** and your webhook endpoint receives `checkout.paid`.

## Exact commands to run the tests

```sh
# API unit tests (checkouts + payment links):
pnpm --filter @openrail/api exec vitest run --config ../../vitest.config.ts --root . src/modules/checkout

# Web unit tests (hosted checkout rules):
pnpm --filter @openrail/web test

# Hosted page e2e + WCAG AA axe checks at 360 px in light and dark themes:
pnpm --filter @openrail/web build
pnpm --filter @openrail/web exec playwright test e2e/checkout.spec.ts

# Mainnet dry-run runner (lists the 4 steps and writes nothing):
NEAR_ENV=mainnet NEAR_ROOT_ACCOUNT=openrail.near NEAR_RPC_URL=https://rpc.mainnet.near.org \
  H1_BUSINESS_ACCOUNT=acme.openrail.near pnpm exec tsx scripts/t2/checkout.ts
```

## Mutation checks

Each break was applied to `services/api/src/modules/checkout/checkouts.ts` or
`services/web/src/modules/checkout/checkout.ts`, the test suite run, and the file restored.

| Break | Caught by |
| --- | --- |
| `Idempotency-Key` requirement removed on `POST /v1/checkouts` | `checkout_create_requires_idempotency_key` |
| `order_ref` uniqueness key widened across businesses or not checked | `checkout_order_ref_unique_per_business` |
| `order_ref` slot not freed when `issuer.issueFor` fails | `checkout_order_ref_freed_when_the_claim_fails` |
| `expires_in_minutes` bounds (1..60) not enforced | `checkout_create_validation` |
| `return_url` allowed over plain `http:` or `javascript:` | `checkout_create_validation`, `checkout_return_url_only_allows_https` |
| `status` read from stored creation record instead of on-chain claim | `checkout_status_is_read_from_the_claim_never_from_the_record` |
| Partial payment reported as `paid` before full `amount_due` is booked | `checkout_paid_only_on_full_amount` |
| Overpayment folded into `paid_total` instead of `surplus` | `checkout_overpay_is_surplus_and_shown_separately` |
| Quotes permitted after checkout `expiry` | `checkout_no_quote_after_expiry` |
| Quote deadline not capped to checkout `expiry` | `checkout_quote_deadline_is_the_expiry_not_later` |
| Event hook emits a notice from core `booked` instead of `checkout_*` | `checkout_notification_from_booked_event_only` |
| Event id not derived from `sha256(token_id ‖ booking_seq)` | `checkout_notification_idempotent` |
| Partial event payload contains `"paid"` | `checkout_partial_notice_never_says_paid` |
| `refund_quote` uses `body.refund_to` from the request instead of the payment log | `late_checkout_refund_only_to_recorded_refund_to` |
| `refund_quote` does not verify the provider quote recipient matches `refund_to` | `late_checkout_refund_refuses_a_quote_that_pays_somebody_else` |
| `refund_quote` permitted when `state.refunded === true` | `late_checkout_refund_once` |
| `accept_late` or `refund_quote` permitted after `accepted` | `checkout_accept_late_refused_unless_late_and_open`, `late_checkout_refund_refused_after_accept_or_when_not_late` |
| Countdown uses provider 3-day `deadline` instead of on-chain `deadline_requested` | `checkout_countdown_uses_requested_deadline` |
| Origin transaction seen (`processing`) not shown as "received, settling" | `pos_shows_settling_on_origin_seen` |
| `pass_to_customer` fee not rounded up to whole cents | `checkout_fee_mode_table_rounding_up` |
| `pass_to_customer` does not add fee to `amount_due` or response breakdown | `checkout_creates_with_fee_mode_pass_to_customer` |
| `fee_mode` does not fall back to business setting | `checkout_fee_mode_defaults_to_business_setting` |
| Idempotency key replay with different `fee_mode` allowed | `checkout_idempotency_different_fee_mode_conflicts` |
| Webhook events omit fee breakdown | `checkout_events_carry_fee_breakdown` |

## Fee mode

A merchant chooses who pays the platform fee via `fee_mode`:
- **`absorb`** (default): the customer pays the order subtotal; the merchant receives the subtotal minus the contract platform fee (25 bps / 0.25%).
- **`pass_to_customer`**: the customer pays the subtotal plus a visible line item **"Processing fee (0.25%)"** in whole cents, rounded **up** (`ceil(subtotal * 0.0025)`).

### Exact rounding arithmetic (USDC base units)

The on-chain contract fee is truncated integer arithmetic: `payment * 25 / 10000`.
For a \$12.00 order subtotal under `pass_to_customer`:
- Order subtotal: \$12.00 (12,000,000 USDC units).
- Fee (0.25% rounded up): \$0.03 (30,000 USDC units).
- Total paid by customer: \$12.03 (12,030,000 USDC units).
- Contract fee deducted: `12,030,000 * 25 / 10,000 = 30,075` USDC units (\$0.030075).
- Net received by merchant: `12,030,000 - 30,075 = 11,999,925` USDC units (\$11.999925).
- Difference from subtotal: -75 USDC units (-\$0.000075), which is within one cent (\$0.01). The merchant is told "you receive about \$12.00".

Subtotal table:
| Subtotal | Fee (0.25% rounded up) | Customer pays (total) | Contract fee (USDC units) | Merchant receives (net) | Net difference from subtotal |
|---|---|---|---|---|---|
| \$12.00 | \$0.03 | \$12.03 | 30,075 | \$11.999925 | -\$0.000075 (< 1¢) |
| \$0.01 | \$0.01 | \$0.02 | 50 | \$0.019950 | +\$0.009950 (< 1¢) |
| \$1,000.00 | \$2.50 | \$1,002.50 | 2,506,250 | \$999.993750 | -\$0.006250 (< 1¢) |
| \$33.33 | \$0.09 | \$33.42 | 83,550 | \$33.336450 | +\$0.006450 (< 1¢) |
| \$4.00 (exact cent) | \$0.01 | \$4.01 | 10,025 | \$3.999975 | -\$0.000025 (< 1¢) |

