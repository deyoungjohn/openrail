# Payout worker (settle support component)

Runs only when the `settle` module is enabled. See `docs/src/modules/settle/payout-worker.md`.
The worker never signs user payments; it holds only `PAYOUT_RELAYER_PRIVATE_KEY` for
`settle_payout`/`report_payout` and reads its state through views. It also polls
`checkout_refund_started` payouts from the indexer and follows them to a settled or refunded status.
