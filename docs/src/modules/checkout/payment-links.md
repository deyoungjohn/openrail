# Payment links

A payment link is a reusable page, `/l/<business>/<slug>`, that anyone can pay. Nothing is
on-chain until a visitor presses **Pay**: each press opens one fresh Checkout (its own claim
account, 60-minute expiry), so one link serves many buyers and every payment is matched exactly.

## API

| Method        | Path                                         | Auth             | Purpose                                                                                          |
| ------------- | -------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `POST`        | `/v1/payment_links`                          | `invoices:write` | Create a link (honours `Idempotency-Key`)                                                        |
| `GET`         | `/v1/payment_links`                          | `invoices:read`  | Your links                                                                                       |
| `GET`/`PATCH` | `/v1/payment_links/{id}`                     | read / write     | One link; turn it on or off, change title, image, amount, quantity, rate limit (`slug` is fixed) |
| `GET`         | `/v1/payment_links/{id}/payments`            | `invoices:read`  | One row per session: `open`, `paid` or `expired`                                                 |
| `GET`         | `/v1/public/payment_links/{business}/{slug}` | none             | What the public page shows                                                                       |
| `POST`        | `/v1/payment_links/{id}/sessions`            | none             | The visitor pressed Pay: opens a Checkout, returns `pay_url`                                     |

- **Amount:** `{"type":"fixed","amount_usd":"150.00"}` (the visitor cannot change it) or
  `{"type":"custom","min_usd":"5.00","max_usd":"500.00"}`. Optional `quantity: {"max": 3}`
  multiplies the amount.
- **Abuse limit:** `rate_limit_per_hour` sessions per link (default 30), sliding hour; then `429`
  with `Retry-After`. A failed Checkout does not use up the budget.
- **Event:** after `checkout_paid`, subscribers also get `payment_link.paid` with
  `payment_link_id` and `session_id` added. It is sent only when the paid token is the one that
  session opened.

## Try it

```sh
curl -s -X POST "$API/v1/payment_links" -H "Authorization: Bearer $OPENRAIL_SECRET_KEY" \
  -H 'content-type: application/json' \
  -d '{"slug":"consult-1h","title":"One-hour consultation","amount":{"type":"fixed","amount_usd":"150.00"}}'
```

→ `201` with `public_path: "/l/<your account>/consult-1h"`. Then

```sh
curl -s -X POST "$API/v1/payment_links/<id>/sessions" -H 'content-type: application/json' -d '{}'
```

→ `201` with a `pay_url` for a $150.00 Checkout. Pay it → `GET /v1/payment_links/<id>/payments`
shows the row as `paid`.

## Mutation checks

Each break was applied to `payment-links.ts`, the module tests run
(`pnpm --filter @openrail/api exec vitest run --config ../../vitest.config.ts --root . src/modules/checkout`),
then restored.

| Break                                          | Caught by                                                    |
| ---------------------------------------------- | ------------------------------------------------------------ |
| rate limit check removed                       | `payment_link_rate_limited`                                  |
| inactive check removed                         | `payment_link_inactive_refuses_session`                      |
| custom minimum not enforced                    | `payment_link_custom_amount_min_enforced`                    |
| fixed amount taken from the client             | `payment_link_fixed_amount_ignores_client_amount`            |
| slug uniqueness key widened                    | `payment_link_slug_unique_per_business`                      |
| token not matched to the session in events     | `payment_link_forged_order_ref_ignored`                      |
| session not marked paid from the event         | `payment_link_payments_lists_sessions_with_status`           |
| rate slot not released after a failed Checkout | `payment_link_checkout_failure_reports_502_and_keeps_budget` |
| ownership check removed                        | `payment_link_scopes_and_ownership`                          |
