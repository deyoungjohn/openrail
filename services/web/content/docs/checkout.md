# Hosted checkout

A checkout is an invoice made for an order: one API call, a hosted pay page, and a signed webhook when it is paid. It is how stores take stablecoins.

## Create one

```bash curl
curl -s -X POST "$API/v1/checkouts" \
  -H "Authorization: Bearer $OPENRAIL_SECRET_KEY" \
  -H "Idempotency-Key: order-1042" \
  -H "content-type: application/json" \
  -d '{"order_ref":"1042","amount_usd":"48.50","expires_in_minutes":30,
       "return_url":"https://shop.example/thanks","cancel_url":"https://shop.example/cart",
       "customer_name":"Malcolm Armas"}'
```

| Field                      | Notes                                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `order_ref`                | Your order id. Unique per business: the same ref and amount returns the existing checkout (`200`); the same ref with another amount is refused (`409 order_ref_amount_mismatch`) |
| `amount_usd`               | Or `amount_cents`. USD only; another currency is refused                                                                                                                         |
| `expires_in_minutes`       | 1 to 60, default 15                                                                                                                                                              |
| `return_url`, `cancel_url` | `https:` only; shown on the pay page as _Back to shop_                                                                                                                           |
| `customer_name`            | Optional, up to 120 characters; shown as the payer in your dashboard and sent back in the webhook                                                                                |

The answer has `id`, `pay_url` (`/c/<id>`), `claim_account`, `expires_at` and `status: "pending"`. The key needs `invoices:write` (and `invoices:read` to read it back).

## The pay page

`pay_url` is a hosted page anyone can open, on a phone or a desktop, in light or dark. The payer picks a coin and a chain, enters a refund address (filled in from a connected wallet), sees the exact price locked until a deadline, and pays from the wallet or sends from an exchange. The page follows the payment to the end and shows the receipt.

## Statuses

| Status                          | Meaning                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `pending`                       | Waiting for payment                                           |
| `partial`                       | Some money arrived; the rest can follow before expiry         |
| `paid`                          | The full amount was booked before expiry (plus a 120 s grace) |
| `late`                          | Paid after expiry: held until you accept it or refund it      |
| `refunded`, `expired`, `closed` | Finished                                                      |

`GET /v1/checkouts/{id}` reads it; `GET /v1/checkouts` lists them. A finished checkout is read from the chain once and kept, so a later read never fails because an RPC is busy.

## Late payments

A payment that arrives after expiry is booked but held. You decide:

- `POST /v1/checkouts/{id}/accept_late` keeps it (the order can be completed; `checkout.accepted` is sent);
- `POST /v1/checkouts/{id}/refund_quote` prepares a refund to the payer's recorded refund address (`checkout.refund_started`).

## Webhooks

`checkout.created`, `checkout.paid`, `checkout.partial`, `checkout.paid_late`, `checkout.accepted` and `checkout.refund_started`. A `checkout.paid` carries `order_ref`, `amount_usd`, `subtotal_usd`, `fee_usd`, `total_usd` and the origin and booking transactions. See [Webhooks](/docs/webhooks).
