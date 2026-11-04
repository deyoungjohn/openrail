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

| Measurement                                       | Denominator              | Value                                            | Source                                                                      |
| ------------------------------------------------- | ------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------- |
| `issue` gas                                       | per invoice              | 15.30 Tgas at claim 1; 15.46 Tgas at claim 5,000 | [`evidence/gate-g1-2026-11-04.md`](../../../evidence/gate-g1-2026-11-04.md) |
| `reconcile` gas, no new funds                     | per call                 | 6.86 Tgas at claim 1; 6.86 Tgas at claim 5,000   | [`evidence/gate-g1-2026-11-04.md`](../../../evidence/gate-g1-2026-11-04.md) |
| `reconcile` gas, payment booked                   | per booked payment       | 17.97 Tgas at claim 1; 18.25 Tgas at claim 5,000 | [`evidence/gate-g1-2026-11-04.md`](../../../evidence/gate-g1-2026-11-04.md) |
| `nft_transfer` gas                                | per transfer             | 3.54 Tgas at claim 1; 3.62 Tgas at claim 5,000   | [`evidence/gate-g1-2026-11-04.md`](../../../evidence/gate-g1-2026-11-04.md) |
| Storage per claim                                 | per invoice              | 1,595 bytes at claim 5,000 (1,684 at claim 1)    | [`evidence/gate-g1-2026-11-04.md`](../../../evidence/gate-g1-2026-11-04.md) |
| `claims_by_issuer` gas, page of 50 matches        | per call at 5,000 claims | 15.41 Tgas                                       | [`evidence/gate-g1-2026-11-04.md`](../../../evidence/gate-g1-2026-11-04.md) |
| `claims_by_issuer` gas, full scan with no matches | per call at 5,000 claims | 540.66 Tgas                                      | [`evidence/gate-g1-2026-11-04.md`](../../../evidence/gate-g1-2026-11-04.md) |
| Root NEAR floor                                   | per claim count          | _pending_                                        | `reports/` T2 report                                                        |

How these were measured: the gate's scale suite runs at 5,000 claims. The
sample points (claims 1, 500, 2,500 and 5,000) are real transactions in the
NEAR sandbox. **The claims between sample points were seeded directly into
contract state, not issued by transactions**, using the same key layout as
`issue`. The gas figures are `total_gas_burnt` of the sample-point
transactions; storage is the change in the root account's `storage_usage`
around the sample-point `issue`. All of it is sandbox data, not mainnet. The
raw output, commit and run time are in the evidence file. The `claims_by_issuer`
cost is explained in [`LIMITATIONS.md`](LIMITATIONS.md).

## Pay-link and cash-out cost

| Measurement               | Denominator                            | Value                                                                                        | Source                                                                                                                        |
| ------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| USDC-route spread         | per USDC route probe                   | 0%                                                                                           | [`evidence/K2prime-partA-routes-2026-10-29T03-08-53Z.json`](../../../evidence/K2prime-partA-routes-2026-10-29T03-08-53Z.json) |
| ETH/SOL tolerance         | per volatile-asset pay link            | quoted 1% tolerance; unused part not refunded (amountIn 2.025734 for 2.000000 out, refund 0) | [`evidence/pay-report-2026-10-31T19-13-15-901Z.json`](../../../evidence/pay-report-2026-10-31T19-13-15-901Z.json)             |
| Cash-out route cost       | per cash-out                           | _pending_                                                                                    | `reports/` T2 report                                                                                                          |
| Payment-to-booked latency | per booked payment (5 timed checkouts) | p50 30.472 s                                                                                 | [`evidence/K12-partB-amended-2026-10-29T12-13-42Z.json`](../../../evidence/K12-partB-amended-2026-10-29T12-13-42Z.json)       |

Method: quote amounts and provider responses are recorded with the transaction
hashes; the report states the denominator used for each row.
