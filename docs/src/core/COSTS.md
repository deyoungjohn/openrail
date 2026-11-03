# Costs

Status: **skeleton**. Every value is filled from a report in `evidence/` or
`reports/`; no number is typed by hand. Cells marked `_pending_` are not measured
for this build yet.

## Denominators

- **Per booked payment**: one `booked` event, one settlement asset, one claim.
- **Per pay link**: one quote and one deposit address.
- **Per cash-out**: one transfer out of the holder's `intents.near` balance.
- **Per invoice**: one `issue` and one claim account.

## Protocol fee

| Measurement  | Denominator        | Value     | Source               |
| ------------ | ------------------ | --------- | -------------------- |
| Protocol fee | per booked payment | _pending_ | `reports/` T2 report |
| Fee bound    | per booked payment | _pending_ | contract test report |

Method: read the `booked` event's fee field and divide by the payment amount;
the report records the transaction hash and the exact base units.

## Gas and storage

| Measurement        | Denominator        | Value     | Source               |
| ------------------ | ------------------ | --------- | -------------------- |
| `issue` gas        | per invoice        | _pending_ | `reports/` T2 report |
| `reconcile` gas    | per booked payment | _pending_ | `reports/` T2 report |
| `nft_transfer` gas | per transfer       | _pending_ | `reports/` T2 report |
| Storage per claim  | per invoice        | _pending_ | `reports/` T2 report |
| Root NEAR floor    | per claim count    | _pending_ | `reports/` T2 report |

Method: the T2 script reads gas from the RPC outcome and storage from the
account state; the report links every transaction.

## Pay-link and cash-out cost

| Measurement               | Denominator                            | Value                                                                                        | Source                                                                                                                        |
| ------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| USDC-route spread         | per USDC route probe                   | 0%                                                                                           | [`evidence/K2prime-partA-routes-2026-10-29T03-08-53Z.json`](../../../evidence/K2prime-partA-routes-2026-10-29T03-08-53Z.json) |
| ETH/SOL tolerance         | per volatile-asset pay link            | quoted 1% tolerance; unused part not refunded (amountIn 2.025734 for 2.000000 out, refund 0) | [`evidence/pay-report-2026-10-31T19-13-15-901Z.json`](../../../evidence/pay-report-2026-10-31T19-13-15-901Z.json)             |
| Cash-out route cost       | per cash-out                           | _pending_                                                                                    | `reports/` T2 report                                                                                                          |
| Payment-to-booked latency | per booked payment (5 timed checkouts) | p50 30.472 s                                                                                 | [`evidence/K12-partB-amended-2026-10-29T12-13-42Z.json`](../../../evidence/K12-partB-amended-2026-10-29T12-13-42Z.json)       |

Method: quote amounts and provider responses are recorded with the transaction
hashes; the report states the denominator used for each row.
