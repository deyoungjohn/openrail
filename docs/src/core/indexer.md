# Indexer: events, receipts and statements

The indexer reads NEP-297 events of `<root>` into SQLite and serves history, statements
(CSV/PDF) and receipts. It holds no keys and never decides amounts.

## Run it

```bash
# required: NEAR_ROOT_ACCOUNT, NEAR_RPC_URL, INDEXER_DB_PATH
# source:   NEARBLOCKS_API_URL / NEARBLOCKS_API_KEY (default source)
pnpm --filter @openrail/indexer start
```

→ `curl -s localhost:8788/health` and see the cursor, last final head, counts and
per-feature call counts.
→ `curl -s 'localhost:8788/history?token_id=c-1&limit=10'` and see indexed events.
→ `curl -s 'localhost:8788/statements?token_id=c-1&from=2026-11-01&to=2026-11-30&format=csv'`
and see the CSV envelope; `format=pdf` returns the PDF envelope.
→ `curl -s localhost:8788/r/<booking-tx-hash>` and see the receipt. Any other hash is 404
(`receipt_equals_booked_event`).

`INDEXER_SOURCE=nearblocks` (default) uses the account-scoped NearBlocks receipts API. If a
NearBlocks request fails, that poll falls back to the RPC scanner (one request per block, still
heavy); `INDEXER_SOURCE=rpc` selects the scanner directly for tests or an emergency run;
it makes roughly one `block` + one `chunk` + one `tx` call per block and is **not** the
production default (about 10 calls/second / ~1M/day at mainnet block time).

## Load budget

NearBlocks is account-scoped: one receipts page per poll in a quiet period.

- **Default cadence** `INDEXER_POLL_INTERVAL_MS=15000`: 4 polls/min → **240 requests in a
  quiet hour** (≈5,760/day).
- A burst that does not fit in 100 receipts follows older pages up to `INDEXER_MAX_PAGES`
  (default 5), then continues on the next poll; each extra page is one request.
- On the NearBlocks free tier (333 calls/day) set `INDEXER_POLL_INTERVAL_MS=300000`
  (12 requests/hour, 288/day) and keep `INDEXER_MAX_PAGES` small.
- `GET /health.calls` reports the counter per feature; the test suite asserts that a quiet
  hour is ≤300 calls (`nearblocks.test.ts`).

## Events per claim and database growth

A typical invoice has **6–12 events**: `issue`, `nft_mint`, `quote_logged`, optional
`ack`, `booked`, 1–6 `distributed` / `distribution_failed` (one per leg, usually 2),
and an optional `nft_transfer`, `surplus` or `cancel`/`close`.

Rough SQLite size: an event row 0.5–1 KB (raw log included), a claim row ~0.3 KB, a booking
plus its legs ~0.5 KB. **10,000 claims ≈ 40–80 MB including indexes.** Evidence rows are
kept forever; only operational rows are pruned.

## Retention

- **Never pruned (evidence):** `issue`, `ack`, `quote_logged`, `booked`, `distributed`,
  `distribution_failed`, `surplus`, `surplus_released`, `cancel`, `close`, `writeoff`,
  `nft_mint`, `nft_transfer`, `unmatched`, `anomaly`.
- **Pruned after `INDEXER_RETENTION_DAYS` (default 30):** `reconcile_failed`,
  `lock_cleared`, `transfer_window`, `config_changed`.
- `pruneTransient()` never touches the evidence set; the retention test proves a `booked`
  receipt survives while `reconcile_failed` is removed.

## Receipts and statements

- Receipts exist only for a `booked` event. The origin transaction and NEAR hashes come from
  1Click `/v0/status` for the claim's latest quote. On EVM routes (`EVM_RPC_URL`) the origin
  transaction is checked on-chain (native transfer or ERC-20 `transfer` to the deposit
  address); other routes use the 1Click amount check.
- Statements include indexed totals and, when the contract view is reachable, a
  `reconciles` flag comparing them with `claim()`.

## Tests

```bash
pnpm --filter @openrail/indexer test   # 43 tests, no network
```

The recorded block fixture is `services/indexer/src/fixtures/blocks.json`; the fake source
replays it. `source.test.ts` covers the off-by-default RPC scanner with a fake RPC.
