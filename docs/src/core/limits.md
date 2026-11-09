# RPCs, indexer and NearBlocks limits

Every service reads NEAR through the same ordered list. The order is deliberate: a busy or
rate-limited RPC is skipped for this call, and the one that answered last is tried first on
the next call.

## RPC URL list

| Variable                         | Order                                                        |
| -------------------------------- | ------------------------------------------------------------ |
| `NEAR_RPC_URL`                   | First; required.                                             |
| `NEAR_RPC_URL_FALLBACK`          | Second.                                                      |
| `NEAR_RPC_URL_FALLBACK_1` … `_9` | Following positions; `FALLBACK1` … `FALLBACK9` are read too. |

Each value may be a comma-separated list. Duplicates are removed. The reader and the
round-robin cursor are in [`near/index.ts`](../../../packages/shared/src/near/index.ts).
`deploy/split-env.sh` copies every fallback spelling into each service env file that already
contains `NEAR_RPC_URL`; a primary-only file still works.

## Indexer

- Idle polling defaults to 30 minutes. `INDEXER_POLL_INTERVAL_MS` overrides it; the first
  event after being idle runs the fast boost loop. See
  [`indexer-sources.md`](indexer-sources.md).
- The API, issuer and watcher poke the indexer before the next idle poll; a boost runs
  every 60 seconds for five minutes.
- `NEARBLOCKS_DAILY_BUDGET` caps NearBlocks requests (default 380). `/v1/health.indexer`
  reports the four booleans and this budget; the metrics endpoint exposes counters but no
  module names. See [`indexer.md`](indexer.md) and
  [`indexer-sources.md`](indexer-sources.md).
- Settled invoices are cached in the `settled` docs namespace, so reads of an old invoice do
  not call NearBlocks or the chain again. Tests are in
  [`settled.test.ts`](../../../services/api/src/settled.test.ts).
- Evidence rows are kept forever: `issue`, `ack`, `quote_logged`, `booked`, `distributed`,
  `distribution_failed`, `surplus`, `nft_mint`, `nft_transfer` and the other paid/cancelled
  events in [`indexer.md`](indexer.md#retention). Only operational rows such as
  `reconcile_failed` and `lock_cleared` are pruned after `INDEXER_RETENTION_DAYS` (30).

## What to do when a limit is hit

1. Read the health body first; a false boolean names the source that is down.
2. Add another RPC URL with a fallback spelling above instead of increasing concurrency.
3. Do not re-poll a settled invoice. Serve the stored receipt/statement; fetch once, save,
   and call out only for new or in-flight work.
