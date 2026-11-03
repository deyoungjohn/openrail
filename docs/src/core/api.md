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
`API_RECIPIENT`, `PAY_BASE_URL`, `WEB_ORIGIN`, `COOKIE_DOMAIN`,
`ISSUER_SERVICE_KEY`, `STORAGE_CREDIT_BALANCE` and `STORAGE_CREDIT_AMOUNT` are
also in `.env.example`. The API process holds **no NEAR key**: `ISSUER_URL`
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
- HMAC-SHA256 webhooks (`Openrail-Signature`), delivered only from indexed events;
- NEP-413 dashboard sessions: `POST /v1/auth/verify` sets the `or_sess` cookie
  (`HttpOnly`, `Secure`, `SameSite=Lax`, `Domain=$COOKIE_DOMAIN`); 7 days sliding,
  capped at 30 days, stored as a sha256 hash so restarts keep it;
  `GET /v1/auth/session` and `POST /v1/auth/logout`.
- SQLite stores (`DATABASE_URL`, `node:sqlite`, schema_migrations): API keys,
  sessions, challenges, idempotency (24 h expiry), webhook endpoints/deliveries,
  business profiles, and the invoice/payment/receipt cache behind the indexer port.
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

## Core routes

| Method | Path                         | Purpose                                                                                                                    |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/invoices`               | Create an invoice and issue the claim through the issuer key.                                                              |
| `GET`  | `/v1/invoices`               | List invoices for the authenticated business.                                                                              |
| `GET`  | `/v1/invoices/{id}`          | Invoice plus the live claim view.                                                                                          |
| `POST` | `/v1/invoices/{id}/send`     | Email the pay link.                                                                                                        |
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

| Method       | Path                                              | Purpose                                                                                             |
| ------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET`/`POST` | `/v1/api_keys`                                    | List keys, or create one (secret shown once).                                                       |
| `POST`       | `/v1/api_keys/{id}/rotate`                        | Rotate; the old key stops working.                                                                  |
| `DELETE`     | `/v1/api_keys/{id}`                               | Revoke a key.                                                                                       |
| `GET`/`POST` | `/v1/webhook_endpoints`                           | List endpoints or create one (secret shown once).                                                   |
| `DELETE`     | `/v1/webhook_endpoints/{id}`                      | Delete an endpoint.                                                                                 |
| `POST`       | `/v1/webhook_endpoints/{id}/test`                 | Send a test event.                                                                                  |
| `GET`        | `/v1/webhook_endpoints/{id}/deliveries`           | Delivery log with attempts and status codes.                                                        |
| `GET`/`PUT`  | `/v1/business`                                    | Business profile: legal name, payout account, contact.                                              |
| `GET`        | `/v1/business/storage_credit`                     | Contract balance plus the account and amount for the user's `deposit_storage_credit` call.          |
| `GET`        | `/v1/statements?from&to&format=csv\|pdf&token_id` | Statement as a base64 envelope; `token_id` limits it to one claim; totals reconcile with `claim()`. |
| `GET`        | `/v1/invoices/{id}/pdf`                           | Invoice PDF as a base64 envelope.                                                                   |
| `GET`        | `/v1/invoices/{id}/open_quotes`                   | Open quotes from the payment log; never reuse an expired one.                                       |
| `POST`       | `/v1/cashout/quote`                               | Route cost and the 1Click deposit address for the holder's `mt_transfer`.                           |
| `GET`        | `/v1/receipts/{booking_tx_hash}`                  | Public receipt built from the `booked` event (no key).                                              |

Invoice objects carry `outstanding` and `paid_total` (base-unit strings);
receipts carry `booking_tx_hash`; the cash-out quote carries `source_asset`,
`deposit_address`, `amount` (the quoted `amountIn`), and `min_amount_in`.

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
