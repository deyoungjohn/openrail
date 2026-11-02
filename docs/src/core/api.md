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

## Auth and idempotency

- `Authorization: Bearer or_sk_live_...` is the server secret key.
- `Authorization: Bearer or_pk_live_...` is the browser key: pay-session creation
  and `GET /v1/routes` only.
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

| Method | Path                         | Purpose                                                       |
| ------ | ---------------------------- | ------------------------------------------------------------- |
| `POST` | `/v1/invoices`               | Create an invoice and issue the claim through the issuer key. |
| `GET`  | `/v1/invoices`               | List invoices for the authenticated business.                 |
| `GET`  | `/v1/invoices/{id}`          | Invoice plus the live claim view.                             |
| `POST` | `/v1/invoices/{id}/send`     | Email the pay link.                                           |
| `GET`  | `/v1/invoices/{id}/receipts` | Receipts rendered from `booked` events only.                  |
| `GET`  | `/v1/payments/{id}`          | Payment state; provider fields live under `swap_details`.     |
| `POST` | `/v1/webhook_endpoints`      | Register a webhook (secret shown once).                       |
| `GET`  | `/v1/events`                 | Indexed events.                                               |
| `GET`  | `/v1/routes`                 | Allow-listed chains and assets.                               |

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
