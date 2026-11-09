# API contract and mock

The S1a contract is `services/api/openapi.json` (OpenAPI 3.1). It covers the core
endpoints in blueprint §1.7 and the hosted pay, acknowledgement and claim views in
§2.7–§2.9. Mock mode serves recorded-shape fixtures so screens can be built before
the backend lands.

## Run the mock API

```bash
MOCK=1 pnpm --filter @openrail/api start
```

→ open `http://127.0.0.1:8787/v1/openapi.json` and see the OpenAPI document.
→ open `http://127.0.0.1:8787/v1/invoices` and see the invoice-list fixture.
→ request any route in `fixtures/api/manifest.json` and see the mapped fixture.

`API_PORT` overrides `8787`. Mock mode answers CORS preflight, so the web dev
server can call it directly. Without `MOCK=1` the process stops: S1a ships the
contract only.

## Run the real API (S1b)

```bash
pnpm --filter @openrail/api start
```

The real server needs `NEAR_ROOT_ACCOUNT`, `NEAR_RPC_URL`, `ISSUER_URL` and the
1Click names already listed in `.env.example`. `DATABASE_URL` (SQLite path),
`INDEXER_URL` (receipts, statements and events), `API_RECIPIENT`,
`PAY_BASE_URL`, `WEB_ORIGIN`, `COOKIE_DOMAIN`, `ISSUER_SERVICE_KEY`,
`STORAGE_CREDIT_BALANCE` and `STORAGE_CREDIT_AMOUNT` are also in `.env.example`. The API process holds **no NEAR key**: `ISSUER_URL`
points at the separate issuer service, which holds the restricted function-call key.

S1b implements:

- canonical terms + `terms_hash` in TypeScript (reproduces
  `fixtures/vectors/terms-v1.json` byte for byte; test `src/terms.test.ts`);
- invoice creation through `issue_for` (the issuer port), with the claim account
  allocated before the terms hash is signed;
- pay sessions: route allow-list → 1Click quote → `log_quote` → deposit address
  (`src/quote.test.ts` proves the order). Amounts are carried as exact base-unit
  `bigint`/strings; `amount_usd` is display-only. `refund_to` is required and is
  validated per origin chain (EVM checksum, Solana 32-byte base58, NEAR account);
- claim views with `kind_rules`, `deadline_requested` (unix seconds) and the
  provider `deadline`;
- EVM acknowledgement relay through the issuer's restricted key
  (`POST /v1/ack/{token_id}/evm`);
- invoice PDF (`application/pdf` base64 envelope);
- `Idempotency-Key` storage (same body returns the first response, another body 409);
- API keys stored as sha256 with scopes, rotated and revoked once;
- HMAC-SHA256 webhooks (`Openrail-Signature`), delivered only from indexed events.
  `storage_sponsored` is carried as an event type; module events appear only when
  their module is enabled;
- NEP-413 dashboard sessions: `POST /v1/auth/verify` sets the `or_sess` cookie
  (`HttpOnly`, `Secure`, `SameSite=Lax`, `Domain=$COOKIE_DOMAIN`); 7 days sliding,
  capped at 30 days, stored as a sha256 hash so restarts keep it;
  `GET /v1/auth/session` and `POST /v1/auth/logout`.
- SQLite stores (`DATABASE_URL`, `node:sqlite`, schema_migrations): API keys,
  sessions, challenges, idempotency (24 h expiry), webhook endpoints/deliveries and
  outbox, business profiles, and the API's own invoice/payment cache. Receipt,
  statement and event reads come from the indexer (`INDEXER_URL`).
- CORS: exact `WEB_ORIGIN` with credentials, never `*`; cookie-authenticated
  state-changing requests require `Origin` and `Content-Type: application/json`.
- `@openrail/api-client` is bundler-friendly (extensionless imports,
  `moduleResolution: "Bundler"`) and sends `credentials: "include"`.

The mock stays available with `MOCK=1 pnpm --filter @openrail/api start` for UI work.

## Auth and idempotency

- `Authorization: Bearer or_sk_live_...` is the server secret key.
- `Authorization: Bearer or_pk_live_...` is the browser key: pay-session creation only.
- `Authorization: Bearer or_sess_...` is a **dashboard session** from NEP-413 sign-in
  (7 days sliding, capped at 30 days, scoped to one business account).
- API-key scopes: `invoices:read`, `invoices:write`, `payments:read`,
  `receipts:read`, `webhooks:write`, and `pay_sessions:create`. A new secret key
  defaults to the first five; a publishable key has exactly `pay_sessions:create`.
  Each endpoint enforces its scope and returns `403 insufficient_scope` with
  `missing scope: <name>`; dashboard sessions hold all scopes.
- Every `POST` accepts `Idempotency-Key`. The same key with the same body returns
  the first response; the same key with another body returns `409`.
- Public hosted-page reads (`/v1/pay/sessions/{id}`, `/v1/pay/claims/{token_id}`,
  `/v1/ack/{token_id}`, `/v1/openapi.json`) take no key.

Keys are read from env by the services; the mock never needs a real key and no
key value appears in a fixture.

## Error shape

Every error response is:

```json
{ "error": { "code": "invoice_not_found", "message": "Invoice not found", "rule": "..." } }
```

`code` is stable; `rule` is present only when a contract rule refused the request.
The fixtures for `400`, `401`, `404` and `409` are in `fixtures/api/`.

## Error codes

| Code                                                                                                                                                         | HTTP        | Meaning                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------ |
| `invalid_request`                                                                                                                                            | 400         | Missing or malformed field.                                        |
| `invalid_terms`                                                                                                                                              | 400         | Canonical terms validation failed.                                 |
| `invalid_refund_address`                                                                                                                                     | 400         | Missing or wrong-chain `refund_to` / cash-out address.             |
| `unknown_route`                                                                                                                                              | 400         | Route is not allow-listed.                                         |
| `unsupported_chain`                                                                                                                                          | 422         | Chain is not supported for this action.                            |
| `quote_failed`                                                                                                                                               | 502         | The provider returned no deposit address.                          |
| `invoice_not_found`, `claim_not_found`, `payment_not_found`, `receipt_not_found`, `pay_session_not_found`, `webhook_endpoint_not_found`, `api_key_not_found` | 404         | Resource does not exist for this business.                         |
| `idempotency_key_reuse`                                                                                                                                      | 409         | Same key with a different body.                                    |
| `invalid_username`, `username_taken`, `username_change_too_soon`                                                                                             | 400/409/429 | Username shape/reserved, already taken, or changed within 30 days. |
| `rpc_busy`                                                                                                                                                   | 503         | Every NEAR RPC is over quota; retry after `retry_after` seconds.   |
| `username_required`                                                                                                                                          | 409         | The business must choose a username before issuing.                |
| `unauthorized`, `invalid_api_key`, `session_expired`, `invalid_nonce`, `challenge_expired`, `wrong_account`, `invalid_signature`, `wrong_signer`             | 401         | Authentication failed.                                             |
| `already_acknowledged`                                                                                                                                       | 409         | The claim already has an acknowledgement.                          |
| `contract_wallet`                                                                                                                                            | 422         | EIP-1271 contract wallets are not supported.                       |
| `insufficient_scope`                                                                                                                                         | 403         | Missing key scope; the message names it.                           |
| `csrf_origin`, `csrf_content_type`                                                                                                                           | 403         | Cookie-authenticated request failed the CSRF checks.               |
| `forbidden`                                                                                                                                                  | 403         | Key kind is not allowed on this endpoint.                          |
| `not_found`                                                                                                                                                  | 404         | Unknown route.                                                     |
| `internal_error`                                                                                                                                             | 500         | Unexpected server error.                                           |

## Core routes

| Method | Path                         | Purpose                                                                                                                    |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/invoices`               | Create an invoice and issue the claim through the issuer key.                                                              |
| `GET`  | `/v1/invoices`               | List invoices for the authenticated business.                                                                              |
| `GET`  | `/v1/invoices/{id}`          | Invoice plus the live claim view.                                                                                          |
| `POST` | `/v1/invoices/{id}/send`     | Not available yet: answers 501 `email_not_available`. Share the pay link or the QR code.                                   |
| `GET`  | `/v1/invoices/{id}/receipts` | Receipts rendered from `booked` events only.                                                                               |
| `GET`  | `/v1/payments`               | Payments for the business (`id`, `invoice_id`, base-unit `amount`, `origin_chain`, `origin_asset`, `status`, `booked_at`). |
| `GET`  | `/v1/payments/{id}`          | Payment state; provider fields live under `swap_details`.                                                                  |
| `POST` | `/v1/webhook_endpoints`      | Register a webhook (secret shown once).                                                                                    |
| `GET`  | `/v1/events`                 | Indexed events.                                                                                                            |
| `GET`  | `/v1/routes`                 | Allow-listed chains and assets.                                                                                            |

## Dashboard sign-in

1. `POST /v1/auth/challenge {account_id}` → `{nonce, message, recipient}`.
2. The NEAR wallet signs the NEP-413 `message` with that account's key.
3. `POST /v1/auth/verify {account_id, public_key, signature, nonce}` →
   `{session_token: "or_sess_...", account_id, expires_at}`.

→ send the session token as `Authorization: Bearer or_sess_...` on dashboard calls.
The server checks the signature and that the public key belongs to the account.

## Developers, business and reporting

| Method       | Path                                              | Purpose                                                                                                      |
| ------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET`/`POST` | `/v1/api_keys`                                    | List keys, or create one (secret shown once).                                                                |
| `POST`       | `/v1/api_keys/{id}/rotate`                        | Rotate; the old key stops working.                                                                           |
| `DELETE`     | `/v1/api_keys/{id}`                               | Revoke a key.                                                                                                |
| `GET`        | `/v1/webhook_event_types`                         | Core event types plus the types enabled modules declare; the dashboard subscribes from this list.            |
| `GET`/`POST` | `/v1/webhook_endpoints`                           | List endpoints or create one (secret shown once).                                                            |
| `DELETE`     | `/v1/webhook_endpoints/{id}`                      | Delete an endpoint.                                                                                          |
| `POST`       | `/v1/webhook_endpoints/{id}/test`                 | Send a test event.                                                                                           |
| `GET`        | `/v1/webhook_endpoints/{id}/deliveries`           | Delivery log with attempts and status codes.                                                                 |
| `GET`/`PUT`  | `/v1/business`                                    | Business profile: `legal_name` (display name), `username` (handle), `account_id` (NEAR), payout and contact. |
| `GET`        | `/v1/business/username_available?u=`              | `{available, reason}` for a candidate handle; the caller's own handle stays available.                       |
| `GET`        | `/v1/business/storage_credit`                     | Own credit, sponsor pool/cap/used/remaining, and the account/amount for `deposit_storage_credit`.            |
| `GET`        | `/v1/statements?from&to&format=csv\|pdf&token_id` | Statement as a base64 envelope; `token_id` limits it to one claim; totals reconcile with `claim()`.          |
| `GET`        | `/v1/invoices/{id}/pdf`                           | Invoice PDF as a base64 envelope.                                                                            |
| `GET`        | `/v1/invoices/{id}/open_quotes`                   | Open quotes from the payment log; never reuse an expired one.                                                |
| `POST`       | `/v1/cashout/quote`                               | Route cost and the 1Click deposit address; see [cash-out](cashout.md).                                       |
| `GET`        | `/v1/cashouts`                                    | The business's cash-outs, newest first. See [statuses](cashout.md#statuses).                                 |
| `GET`        | `/v1/cashouts/{id}`                               | One cash-out, its chain transaction and provider status.                                                     |
| `POST`       | `/v1/cashouts/{id}/sent`                          | Attach the signed transaction hash (20–64 alphanumeric characters).                                          |
| `GET`        | `/v1/receipts/{booking_tx_hash}`                  | Public receipt built from the `booked` event (no key).                                                       |

A username is 3 to 32 lowercase letters, digits, `-` or `_`; it starts and ends with a letter or
digit, has no repeated separators, and is never a reserved page name. A dotted handle is allowed
only for the caller's own NEAR account id. Pay and acceptance links are
`<base>/<username>/inv/<ref>` and `<base>/<username>/inv/ack/<ref>`; `<ref>` resolves the invoice
after a rename. A username change is limited to once per 30 days, and the previous handle is not
released to other businesses until those 30 days pass.

Invoice objects carry `outstanding` and `paid_total` (base-unit strings);
receipts carry `booking_tx_hash`; the cash-out quote carries `source_asset`,
`deposit_address`, `amount` (the quoted `amountIn`), and `min_amount_in`.

## Recurring invoices

| Method        | Path                          | Purpose                                                  |
| ------------- | ----------------------------- | -------------------------------------------------------- |
| `POST`/`GET`  | `/v1/recurring_invoices`      | Create a template, or list them.                         |
| `GET`/`PATCH` | `/v1/recurring_invoices/{id}` | Template plus its runs; pause, resume, cancel or change. |

A template repeats `weekly`, `monthly` or `quarterly` from `start_date`, until
`end_date` (inclusive) or `count` dates, or until cancelled. On each date at
06:00 UTC the API issues an ordinary invoice through `issue_for`, numbered
`<prefix>-001`, `<prefix>-002`, …, due `due_days` later, and returns the pay link
(`send_email` must be `false`; email is not available yet). Nothing is pulled from the client; they pay each
invoice like any other.

- Monthly and quarterly dates keep the start day and clamp to the month end:
  start 31 Jan → 28 Feb → 31 Mar → 30 Apr.
- Each date is issued at most once (one run row per template and date).
- A failed issue is retried on the next two passes, then marked `failed` and
  the template's `attention` field says so.
- A run whose outcome is unknown after a restart is marked `unknown`, never
  re-issued; check the invoice list before issuing it by hand.
- Dates missed by more than 3 days (for example while paused) are recorded as
  `skipped`.
- Invoices from a template carry `recurring_id`, and so do their webhook events.

Try it:

```sh
curl -s -X POST "$API/v1/recurring_invoices" \
  -H "Authorization: Bearer $OPENRAIL_SECRET_KEY" -H 'content-type: application/json' \
  -d '{"repeat":"monthly","start_date":"2026-12-01","count":12,
       "invoice":{"invoice_number_prefix":"RET","issuer_legal_name":"Acme Ltd",
       "debtor_legal_name":"Client Co","debtor_key":"client.near","amount_usd":"1500.00"}}'
```

→ `201` with `status: "active"` and `next_run_date: "2026-12-01"`. On that date,
after 06:00 UTC, `GET /v1/invoices` lists `RET-001` with `recurring_id` set.

## Hosted-page routes

| Method | Path                        | Purpose                                                                                                                                              |
| ------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/pay/sessions`          | Request a quote and pay session. The quote is written to the payment log before the deposit address is returned (`quote_note_before_address_shown`). |
| `GET`  | `/v1/pay/sessions/{id}`     | Poll a payment; 1Click fields are under `swap_details`.                                                                                              |
| `GET`  | `/v1/pay/claims/{token_id}` | Public invoice, terms and routes for the pay page.                                                                                                   |
| `GET`  | `/v1/ack/{token_id}`        | Every field the acknowledgement page renders, plus the EIP-712 domain and message.                                                                   |

A quote is never reused after its requested deadline; an expired session must be
recreated. The page counts down to the requested deadline, not the provider's
`deadline` echo (blueprint §1.5.7).

## Typed client

`packages/api-client` is generated from the OpenAPI document. Types and the
operation map live in `src/generated.ts`; the thin helpers are hand-written.

```ts
import { createClient } from "@openrail/api-client";

const api = createClient({
  baseUrl: "http://127.0.0.1:8787",
  apiKey: process.env.OPENRAIL_API_KEY,
});

const invoice = await api.invoices.create(
  {
    invoice_number: "INV-2026-001",
    issuer_legal_name: "Acme Ltd",
    debtor_legal_name: "Debtor Co",
    debtor_key: "debtor.openrail.near",
    amount_usd: "12.50",
    due_date: "2026-12-01",
    line_items: [{ description: "Design", quantity: 1, unit_amount_usd: "12.50" }],
  },
  { idempotencyKey: "invoice-2026-001" },
);
```

→ run the snippet against the mock and see the `invoices.create.json` fixture.
→ change `services/api/openapi.json`, run `pnpm --filter @openrail/api-client generate`
and see `src/generated.ts` update.

## Fixtures and contract test

`fixtures/api/manifest.json` maps each fixture to its method, path, status and
component schema. `pnpm --filter @openrail/api test` checks that:

- every fixture validates against the named OpenAPI schema;
- every fixture points at a real operation and response status;
- every operation except the OpenAPI meta route has a success fixture;
- the mock server returns each fixture at its route and the documented 404 shape.

See `fixtures/api/README.md` for the fixture sources.
