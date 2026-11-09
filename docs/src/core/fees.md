# Fees, line items and payouts

The contract takes 25 bps (0.25%) of every booked payment. The business chooses who pays it.

- `absorb` (default): the customer pays the invoice amount and the business receives it less the
  contract fee.
- `pass_to_customer`: the API adds one real line item, `Processing fee (0.25%)`, and the customer
  pays subtotal plus that fee. The fee is rounded up to a whole cent:
  `fee_cents = ceil(subtotal_cents * 25 / 10000)`.

For a $12.00 subtotal the fee is 3 cents, so the customer pays $12.03. In USDC units the contract
takes `12030000 * 25 / 10000 = 30075` micro-USDC and leaves `11999925` ($11.999925), within one cent
of the $12.00 subtotal. The preview says "you receive about $12.00".

A line item is stored as `{description, quantity, unit_amount_usd, amount_usd}`; `amount_usd` is
`quantity * unit_amount_usd` in exact cents. The browser canonical form is
`JSON.stringify(line_items)` with those four fields in that order. `line_items_sha256` in the terms
is `sha256` of exactly that string, and the public claim, acceptance data, invoice PDF and receipt
serve the same array. Old invoices have an empty array.

`GET /v1/fee_preview?subtotal_usd=` returns the fee, total and merchant amount for the business
setting (or a `fee_mode` override).

`GET /v1/receipts/{booking_tx_hash}.json` returns a deterministic RFC 8785-style canonical JSON
receipt for a booked payment, with the amounts, transactions, claim account, terms fingerprint and
the `openrail-verify` command. It is public and unsigned for now.

`GET /v1/payout/estimate?destination=base` returns dry 1Click quotes for $5, $50 and $500 to that
destination. A quote request creates no deposit address that is used and moves no funds.
