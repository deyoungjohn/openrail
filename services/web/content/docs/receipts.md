# Receipts and statements

Every payment gets a receipt, and any period gets a statement. Both carry what a reader needs to check them on the chain.

## Receipts

A receipt is created for every booked payment. It has a public page, a PDF and a canonical JSON, all addressed by the booking transaction:

| Form | Address                                   |
| ---- | ----------------------------------------- |
| Page | `/r/<booking_tx_hash>`                    |
| PDF  | `GET /v1/receipts/<booking_tx_hash>.pdf`  |
| JSON | `GET /v1/receipts/<booking_tx_hash>.json` |

The receipt shows the business, who paid, the line items, the amount, the fee and the total, then **Check it onchain**:

- the invoice's own account, linked to the explorer;
- the **terms fingerprint**, the SHA-256 of the canonical terms the client saw;
- the **NEAR booking transaction** and the **payer's transaction** on its own chain, each linked;
- the network, what was settled (for example _48.50 USDC on NEAR_) and the order reference;
- the `openrail-verify` command that checks all of it.

The JSON is canonical (RFC 8785 style): the same receipt always has the same bytes.

## Invoice PDFs

The business's own invoice PDF uses the same template: _INVOICE_, the status, issue and due dates, the line items, the pay link, the onchain check and the terms. `GET /v1/invoices/{id}/pdf` returns it.

## Statements

In the app's **Statements** page, pick a period and a format (PDF or CSV). The statement lists every settled payment in the period with its date, its source and its amount, then the total.

Each statement has a **fingerprint**. Load a statement file back on the same page and it tells you whether the fingerprint matches: a changed file does not.

`GET /v1/statements?from=…&to=…&format=pdf|csv` returns the same file over the API.

## Dashboard

The dashboard reads the bookings: monthly revenue, weekly activity, top clients, the chains clients paid from, the earning streams (invoice, checkout) and an inflow table with explorer links. It is read from the indexed contract events, not from anything the business typed.
