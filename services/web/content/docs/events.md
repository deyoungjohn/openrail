# Event types

The webhook event types, what triggers each, and the contract events they come from. Every webhook is built from an event indexed from `openrail.near`, so each one matches something on the chain.

## Invoice events

| Type                     | Meaning                                              |
| ------------------------ | ---------------------------------------------------- |
| `invoice.created`        | An invoice was issued                                |
| `invoice.accepted`       | The client acknowledged the invoice's terms          |
| `invoice.partially_paid` | Some of the amount due is booked                     |
| `invoice.paid`           | The amount due is fully booked                       |
| `payment.late`           | A payment arrived after the invoice was closed       |
| `payout.failed`          | Paying the owner's share out failed                  |
| `invoice.closed`         | The invoice is finished                              |
| `storage_sponsored`      | The invoice's storage was paid from the sponsor pool |

> [!WARNING]
> In this build, deliveries are matched on the indexed event's own name. Checkout events (below) are delivered, and the store plugins rely on them. The `invoice.*` names are listed but not yet mapped from the contract's events, so an endpoint subscribed only to them receives nothing. Until they are, follow invoices with `GET /v1/invoices/{id}` or `GET /v1/events?type=booked`. See [Limitations](/docs/limitations).

## Checkout events

| Type                      | When                                                  | Data                                                                              |
| ------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `checkout.created`        | A checkout was opened                                 | `order_ref`, `amount_usd`                                                         |
| `checkout.paid`           | The full amount was booked before expiry (plus 120 s) | `order_ref`, `amount_usd`, `subtotal_usd`, `fee_usd`, `total_usd`, `transactions` |
| `checkout.partial`        | Part of the amount arrived                            | `due`, `received`, `remaining` (never the word "paid")                            |
| `checkout.paid_late`      | Booked after expiry; held                             | `order_ref`, `amount_usd`, `transactions`                                         |
| `checkout.accepted`       | The merchant kept a late payment                      | `order_ref`                                                                       |
| `checkout.refund_started` | A late payment is being refunded                      | `refund_to`, `amount_in`                                                          |

## Contract events

The contract writes NEP-297 events (standard `openrail`, version `1.0.0`) to its logs. The main ones:

| Event                                | Data                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `issue`                              | `token_id`, `kind`, `issuer_id`, `owner_id`, `debtor`, `terms_hash`, `amount_due`, `due_date` |
| `booked`                             | `token_id`, `payment`, `surplus`, `fee`, `credit`, `legs`                                     |
| `distributed`, `distribution_failed` | The owner's share sent, or not                                                                |
| `ack`                                | The client's acknowledgement                                                                  |
| `close`, `cancel`, `writeoff`        | The end of a claim                                                                            |
| `nft_mint`, `nft_transfer`           | NEP-171 token events (standard `nep171`)                                                      |
| `storage_sponsored`                  | The sponsor pool paid an invoice's storage                                                    |

Read them through `GET /v1/events` (filter with `?type=booked`), or straight from the chain.
