# Authentication and errors

The Openrail API is plain REST over HTTPS with JSON bodies. This page covers keys, scopes, idempotency and the error shape that every route shares.

## Base URL

```text Base URL
https://api.openrail.incepture.dev
```

The full machine-readable reference is the OpenAPI 3.1 document at [`/v1/openapi.json`](https://api.openrail.incepture.dev/v1/openapi.json).

## Keys

Send a key as a bearer token:

```bash curl
curl -s "$API/v1/invoices" -H "Authorization: Bearer or_sk_live_..."
```

| Key               | Prefix        | Use                                                                                                |
| ----------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| Secret key        | `or_sk_live_` | Your server. Created in **API Integration**, shown once, stored by Openrail only as a SHA-256 hash |
| Publishable key   | `or_pk_live_` | A browser. Can only create pay sessions                                                            |
| Dashboard session | `or_sess_`    | The web app, after a NEAR wallet sign-in (an HttpOnly cookie, 7 days sliding, capped at 30)        |

Keys can be rotated (`POST /v1/api_keys/{id}/rotate`) and revoked (`DELETE /v1/api_keys/{id}`).

## Scopes

| Scope                 | Allows                                                 |
| --------------------- | ------------------------------------------------------ |
| `invoices:read`       | Read invoices and checkouts                            |
| `invoices:write`      | Create invoices and checkouts; late-payment actions    |
| `payments:read`       | Read payments, events, balances                        |
| `receipts:read`       | Read receipts and statements                           |
| `webhooks:write`      | Manage webhook endpoints                               |
| `pay_sessions:create` | Create pay sessions (the publishable key's only scope) |

A new secret key gets the first five. A call outside a key's scopes returns `403 insufficient_scope` and names the missing scope.

## Idempotency

Every `POST` accepts an `Idempotency-Key` header. The same key with the same body within 24 hours returns the first response; the same key with another body returns `409 idempotency_key_reuse`. Use your own order or invoice id as the key, so a retry after a timeout never creates a second one.

## Errors

Every error has the same shape. `code` is stable and safe to branch on; `message` is for people; `rule` appears only when a contract rule refused the request.

```json Error
{ "error": { "code": "invoice_not_found", "message": "Invoice not found", "rule": "..." } }
```

| Code                                                 | HTTP | Meaning                                                      |
| ---------------------------------------------------- | ---- | ------------------------------------------------------------ |
| `invalid_request`                                    | 400  | A field is missing or malformed                              |
| `invalid_refund_address`                             | 400  | The refund or cash-out address does not fit the chain        |
| `unknown_route`                                      | 400  | The coin and chain are not allow-listed                      |
| `unsupported_chain`                                  | 422  | The chain is not supported for this action                   |
| `unauthorized`, `invalid_api_key`, `session_expired` | 401  | Authentication failed                                        |
| `insufficient_scope`, `forbidden`                    | 403  | The key cannot do this                                       |
| `invoice_not_found`, `payment_not_found`, …          | 404  | Not found for this business                                  |
| `idempotency_key_reuse`                              | 409  | Same key, different body                                     |
| `order_ref_amount_mismatch`                          | 409  | A checkout with this order ref exists with another amount    |
| `provider_rejected`                                  | 422  | NEAR Intents refused the quote; `message` carries its reason |
| `quote_failed`, `provider_unavailable`               | 502  | The provider gave no price                                   |
| `issuer_unavailable`, `rpc_busy`                     | 503  | Retry after `retry_after` seconds                            |

## Rate and freshness

Reads that touch the chain are cached briefly and spread over several NEAR RPCs; when every RPC is over quota the API answers `503 rpc_busy` with `retry_after`. Pay sessions follow the provider's status every few seconds until an hour after their deadline.
