# Endpoints

Every route, grouped by what it is for. Bodies and responses are described exactly in the [OpenAPI document](https://api.openrail.incepture.dev/v1/openapi.json).

## Invoices

| Method  | Path                            | Purpose                                        |
| ------- | ------------------------------- | ---------------------------------------------- |
| `POST`  | `/v1/invoices`                  | Create and issue an invoice                    |
| `GET`   | `/v1/invoices`                  | List your invoices                             |
| `GET`   | `/v1/invoices/{id}`             | An invoice and its live claim view             |
| `GET`   | `/v1/invoices/{id}/pdf`         | The invoice PDF (base64 envelope)              |
| `GET`   | `/v1/invoices/{id}/receipts`    | The receipts of its booked payments            |
| `GET`   | `/v1/invoices/{id}/open_quotes` | Prices given to the client that are still open |
| `POST`  | `/v1/recurring_invoices`        | Create a recurring template                    |
| `GET`   | `/v1/recurring_invoices`        | List templates                                 |
| `GET`   | `/v1/recurring_invoices/{id}`   | A template and its runs                        |
| `PATCH` | `/v1/recurring_invoices/{id}`   | Pause, resume, cancel or change it             |
| `GET`   | `/v1/fee_preview`               | The fee and total for a subtotal               |

## Checkouts

| Method | Path                              | Purpose                               |
| ------ | --------------------------------- | ------------------------------------- |
| `POST` | `/v1/checkouts`                   | Open a hosted checkout for an order   |
| `GET`  | `/v1/checkouts`                   | List checkouts                        |
| `GET`  | `/v1/checkouts/{id}`              | A checkout, its status and payments   |
| `POST` | `/v1/checkouts/{id}/accept_late`  | Keep a payment that came after expiry |
| `POST` | `/v1/checkouts/{id}/refund_quote` | Prepare the refund of a late payment  |

## Payments and analytics

| Method | Path                | Purpose                                                        |
| ------ | ------------------- | -------------------------------------------------------------- |
| `GET`  | `/v1/payments`      | Payments booked to you                                         |
| `GET`  | `/v1/payments/{id}` | A payment and its provider swap status                         |
| `GET`  | `/v1/events`        | Indexed events of your claims, newest first (`?type=` filters) |
| `GET`  | `/v1/analytics`     | Revenue and activity, computed from the bookings               |
| `GET`  | `/v1/routes`        | Chains and coins that can pay right now                        |

## Pay sessions (hosted pages)

| Method | Path                                 | Purpose                                         |
| ------ | ------------------------------------ | ----------------------------------------------- |
| `POST` | `/v1/pay/sessions`                   | Create a pay session and its first quote        |
| `GET`  | `/v1/pay/sessions/{id}`              | Follow a pay session                            |
| `POST` | `/v1/pay/sessions/{id}/deposit`      | Tell the provider about the deposit transaction |
| `GET`  | `/v1/pay/claims/{token_id}`          | The public view of an invoice for the pay page  |
| `GET`  | `/v1/pay/claims/{token_id}/sessions` | Prices already given for an invoice             |

## Receipts and statements

| Method | Path                             | Purpose                              |
| ------ | -------------------------------- | ------------------------------------ |
| `GET`  | `/v1/receipts/{booking_tx}.json` | Canonical receipt (public)           |
| `GET`  | `/v1/receipts/{booking_tx}.pdf`  | Receipt PDF (public)                 |
| `GET`  | `/v1/statements`                 | A statement for a period, CSV or PDF |

## Payouts and balances

| Method | Path                                      | Purpose                                            |
| ------ | ----------------------------------------- | -------------------------------------------------- |
| `GET`  | `/v1/balance/intents`                     | What you hold on `intents.near`                    |
| `POST` | `/v1/cashout/quote`                       | Quote a cash-out to another chain                  |
| `GET`  | `/v1/cashouts`                            | Your cash-outs, newest first                       |
| `GET`  | `/v1/cashouts/{id}`                       | One cash-out and where the money is                |
| `POST` | `/v1/cashouts/{id}/sent`                  | Attach the transaction you signed                  |
| `GET`  | `/v1/payout/estimate`                     | What one payout to a destination costs now         |
| `GET`  | `/v1/balance/confidential`                | Your confidential balance (needs a signed session) |
| `POST` | `/v1/balance/confidential/withdraw/quote` | Quote a confidential withdrawal                    |

## Webhooks

| Method   | Path                                    | Purpose                          |
| -------- | --------------------------------------- | -------------------------------- |
| `POST`   | `/v1/webhook_endpoints`                 | Register an endpoint             |
| `GET`    | `/v1/webhook_endpoints`                 | List endpoints                   |
| `DELETE` | `/v1/webhook_endpoints/{id}`            | Delete an endpoint               |
| `POST`   | `/v1/webhook_endpoints/{id}/test`       | Send a signed test event         |
| `GET`    | `/v1/webhook_endpoints/{id}/deliveries` | The delivery log                 |
| `GET`    | `/v1/webhook_event_types`               | Event types you can subscribe to |

## Keys, business and sign-in

| Method   | Path                          | Purpose                                                |
| -------- | ----------------------------- | ------------------------------------------------------ |
| `GET`    | `/v1/api_keys`                | List keys (without secrets)                            |
| `POST`   | `/v1/api_keys`                | Create a key; the secret is returned once              |
| `POST`   | `/v1/api_keys/{id}/rotate`    | Rotate a key                                           |
| `DELETE` | `/v1/api_keys/{id}`           | Revoke a key                                           |
| `GET`    | `/v1/business`                | Your business profile                                  |
| `PUT`    | `/v1/business`                | Update username, legal name, payout account or contact |
| `GET`    | `/v1/business/storage_credit` | Storage credit and the sponsor pool                    |
| `POST`   | `/v1/auth/challenge`          | A NEP-413 sign-in challenge                            |
| `POST`   | `/v1/auth/verify`             | Verify the signature and start a session               |

## Public

| Method | Path               | Purpose                                              |
| ------ | ------------------ | ---------------------------------------------------- |
| `GET`  | `/v1/health`       | Liveness and readiness                               |
| `GET`  | `/v1/openapi.json` | The OpenAPI 3.1 document                             |
| `GET`  | `/v1/public/proof` | The demo business's transactions, for the Proof page |
