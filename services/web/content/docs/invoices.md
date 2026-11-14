# Send an invoice

Bill a client with line items and a due date, send the pay link, and follow the payment, in the app or over the API.

## In the app

1. Sign in and open **Invoices → Create invoice**.
2. Fill in the client's name, an optional address (printed on the receipt, not part of the terms), the invoice number and the due date.
3. Add line items: description, quantity and price. The total is computed in exact cents.
4. Choose **Create invoice**. The contract issues the claim and its account; you get the pay link and a QR code to send.

The invoice page then shows the money (amount due, paid in, fee, still to pay), the invoice's own account, the payments with explorer links, and the receipts.

## Over the API

```bash curl
curl -s -X POST "$API/v1/invoices" \
  -H "Authorization: Bearer $OPENRAIL_SECRET_KEY" \
  -H "Idempotency-Key: inv-2026-001" \
  -H "content-type: application/json" \
  -d '{
    "invoice_number": "INV-2026-001",
    "issuer_legal_name": "Belmonte Apparels",
    "debtor_legal_name": "Northwind Ltd",
    "amount_usd": "1240.00",
    "due_date": "2026-12-01",
    "line_items": [
      { "description": "Brand design, 2 weeks", "quantity": 1, "unit_amount_usd": "1100.00" },
      { "description": "Revisions", "quantity": 1, "unit_amount_usd": "140.00" }
    ]
  }'
```

Required: `invoice_number`, `issuer_legal_name`, `debtor_legal_name`, `amount_usd`, `due_date`, `line_items`. Optional: `client_address`, and `debtor_key` when the client has a NEAR account or an EVM address of its own.

The answer includes `token_id`, `claim_account` and `pay_link`. The line items are hashed (`line_items_sha256`) into the terms, so the receipt can prove them.

## Follow it

- `GET /v1/invoices/{id}`: the invoice and its live claim view (status, paid total, still due).
- `GET /v1/invoices/{id}/receipts`: a receipt per booked payment.
- `GET /v1/events?type=booked`: every booking of your invoices, newest first. (The `invoice.*` webhook names are not delivered yet; see [Event types](/docs/events).)

## Recurring invoices

`POST /v1/recurring_invoices` creates a template (`repeat`, for example `monthly`, a `start_date` and a `count` of runs). Each run issues a normal invoice. `PATCH` pauses, resumes, cancels or changes it.

## Statuses and amounts

Amounts are US dollars as strings with two decimals (`"1240.00"`), or USDC base units (6 decimals) where a field says so. Only USD invoices are supported.
