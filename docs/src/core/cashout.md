# Cash-out API

Cash-out moves USDC from the business's Openrail balance to another chain. The API stores
the quote and the transaction the business signs, then follows both the provider and the
chain until the transfer settles. Listing, getting and marking sent need scope
`payments:read`; creating a quote needs the caller's normal authenticated session.

## Quote

`POST /v1/cashout/quote` (`Idempotency-Key` supported) takes:

| Field               | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `amount`            | USDC base units to move.                                              |
| `destination_chain` | Destination chain; the provider validates the chain and address pair. |
| `address`           | Destination address, validated for the chain.                         |
| `source_asset`      | Optional settlement asset; must be one of the configured assets.      |

→ `201` with the route cost, the provider deposit address and the stored cash-out `id`.
The quote is kept; a later list or get returns the same `id`.

## Follow it

| Method | Path                     | Purpose                                                        |
| ------ | ------------------------ | -------------------------------------------------------------- |
| `GET`  | `/v1/cashouts`           | The business's cash-outs, newest first.                        |
| `GET`  | `/v1/cashouts/{id}`      | One cash-out and where the money is now.                       |
| `POST` | `/v1/cashouts/{id}/sent` | Attach the `tx_hash` the business signed (20–64 alphanumeric). |

The provider is asked only while the cash-out is under 14 days old; the chain transaction
status is checked whenever a `tx_hash` is attached. A settled cash-out keeps its stored
provider evidence. The polling window is in [`app.ts`](../../../services/api/src/app.ts).

## Statuses

| Status       | What it means                                                             |
| ------------ | ------------------------------------------------------------------------- |
| `quoted`     | Quote stored; no signed transaction has been attached.                    |
| `sent`       | The business attached a transaction hash; waiting for the provider.       |
| `processing` | The provider sees the deposit/transaction.                                |
| `success`    | The money reached the destination; `destination_tx_hashes` has the proof. |
| `refunded`   | The transfer was returned to the refund address.                          |
| `incomplete` | A short deposit is waiting for the rest before the transfer can complete. |
| `failed`     | The provider or the chain reports a failure; nothing more will move.      |
| `expired`    | The quote deadline passed before a transaction was sent.                  |

`tx_state` is the chain's separate answer for the attached transaction
(`pending`/`success`/`failed`/`unknown`); `provider_status` is the provider's raw word.
The two can disagree while a transfer is in flight.

## Database

Cash-outs live in the API's `docs` namespace under `cashouts`, keyed by the business
account; the record keeps the quote, asset, destination, transaction and provider evidence.
No key is held by the API. See [`api.md`](api.md) for the OpenAPI document and client.
