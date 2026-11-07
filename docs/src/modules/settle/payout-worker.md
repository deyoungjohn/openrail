# Settle payout worker

Status: **built** in `services/payout`. The worker is started only when `settle` is enabled.

For each `settle_held` entry on a claim it:

1. requests an `EXACT_INPUT` 1Click quote with `depositType: INTENTS` and `refundTo` = the claim account;
2. checks the quote recipient equals the owner's registered settlement destination **before** sending;
3. calls `settle_payout(token, index, deposit_address, amount_in)`;
4. polls `/v0/status` for that deposit address;
5. calls `report_payout` with `Settled {destination_tx}` on SUCCESS or `Refunded {amount}` on a refund/failed delivery.

`INCOMPLETE_DEPOSIT` is not a refund: it is waiting for the rest of the deposit, so the worker leaves it pending and only reports when the provider says `REFUNDED`. If a refund status arrives without an amount, the worker does not guess: it leaves the entry `InFlight`, logs it and raises the health alert for the human.

A restart is safe: entries already `InFlight` are read from `settle_held` and only polled/reported; they are never sent again. Before every send the worker re-reads `settle_held` after a short wait and skips an entry that became `InFlight`, so a delayed send from before a restart is not sent twice.

## Checkout refunds

The same worker also reads `checkout_refund_started` events. A merchant refund creates the payout on
the contract, so the worker only polls the provider status and records the outcome; it never calls
`refund_late` again. For an event without a payout id it takes the prepared quote path: it checks the
quote recipient equals the recorded `refund_to` before any value-moving call, refuses an amount above
the booked net, and keeps an ambiguous send uncertain rather than retrying. A restart resumes from the
on-chain `InFlight` payout.

## Run

```bash
pnpm --filter @openrail/payout start
```

Environment: `NEAR_ROOT_ACCOUNT`, `NEAR_RPC_URL`, `INDEXER_URL`,
`PAYOUT_RELAYER_ACCOUNT_ID`, `PAYOUT_RELAYER_PRIVATE_KEY`, optional
`PAYOUT_POLL_INTERVAL_MS` (15000), `PAYOUT_HEALTH_PORT` (8081),
`PAYOUT_MIN_BALANCE_NEAR` (0.5), `ALERT_WEBHOOK_URL`, plus the 1Click names.

→ `curl http://127.0.0.1:8081/health` and see the last tick, last summary and relayer balance.
→ after a booking that holds the owner's share, see `settle_sent` in the indexer and a
`settle_settled` event once the destination transaction exists.

## Tests

`pnpm --filter @openrail/payout test` covers the recipient check before send, success/refund
reporting, restart-resume of an in-flight payout, and the ambiguous-send no-retry rule with a
fake 1Click and fake chain. It also covers checkout refund recipient mismatch, booked-net cap,
restart resume and ambiguous sends.
