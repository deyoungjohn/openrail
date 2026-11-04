# Indexer discovery sources and limits

Status: **built** for the NearBlocks budget governor and registered-tx path; the
alternatives below are **exploring** and not switched on.

## Calls per action

- **Quiet sweep**: one NearBlocks `/v1/account/<root>/txns` call per page, then one
  RPC `EXPERIMENTAL_tx_status` per new transaction. The baseline is five minutes with
  two pages, so a quiet day costs at most 288 NearBlocks calls before the budget cap.
- **Boost**: `POST /poke` (loopback) raises the cadence to 20 s for five minutes, which
  is at most 15 NearBlocks calls, and only while the day's budget remains.
- **Registered transaction**: `POST /register-tx` costs one RPC
  `EXPERIMENTAL_tx_status` and no NearBlocks call.
- **Receipt**: served from the locally indexed `booked` row; no provider call.

The API calls `/poke` when creating a pay session or quote; the watcher calls it after
`reconcile`.

## Budget governor

- `NEARBLOCKS_DAILY_BUDGET` defaults to 380; there is a 7 s minimum spacing between
  NearBlocks calls (the 10/min limit).
- The counter is stored in the indexer SQLite database and rolls at 00:00 UTC; a
  restart keeps it.
- A spent budget or HTTP 429 stops NearBlocks until the next UTC day, logs once, and
  reports `nearblocks_budget` plus `degraded` in `/health`. The RPC block scanner is
  not used as a fallback in that state.

## Observed limits (probed 4 Nov 2026)

| Source     | Probe                                                                 | Observation                                                                                                               |
| ---------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| NearBlocks | `GET https://api.nearblocks.io/v1/account/openrail.near/txns?limit=1` | `200` keyless JSON with `cursor`/`txns`; the account plan is 10/min, 420/day, 12,500/month (0 used at the start).         |
| FastNEAR   | former `explorer.fastnear.com/api/v0/account/...`                     | `301` to `near.rocks`; the redirected paths returned the HTML app, not JSON. No keyless account-transaction API verified. |
| neardata   | `GET https://mainnet.neardata.xyz/v0/block/24909407`                  | `302` to `a0.mainnet.neardata.xyz`; followed to `200` JSON block. Block-level only; no per-account transaction index.     |
| Pikespeak  | `GET https://api.pikespeak.ai/account/txns/openrail.near?limit=1`     | `401 Missing x-api-key header`; requires an API key. Free-tier limits not verified.                                       |

No source is switched. NearBlocks remains behind the same `EventSource` interface, so a
future source is an adapter rather than a rewrite.
