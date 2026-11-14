# Services

Each service does one job, holds as little as it can, and can be restarted at any time without losing money or booking twice.

| Service           | Package            | Job                                                                            | Holds                                                |
| ----------------- | ------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| API               | `services/api`     | The REST API, hosted-page data, webhooks, the Proof feed                       | No NEAR key; API key hashes, sessions                |
| Web               | `services/web`     | The dashboard, hosted pay, checkout and receipt pages, the site and these docs | Nothing secret                                       |
| Issuer            | `services/issuer`  | Creates invoices (`issue_for`) and logs quotes (`log_quote`)                   | A restricted function-call key for those two methods |
| Watcher           | `services/watcher` | Books payments (`reconcile`), retries, clears stale locks                      | A gas account                                        |
| Indexer           | `services/indexer` | Reads the contract's events into SQLite; receipts, statements, analytics       | Nothing secret                                       |
| Payout worker     | `services/payout`  | Pays held shares to owners' destinations; follows refunds                      | A gas account (`settle_payout`, `report_payout`)     |
| Relayer           | `services/relayer` | Relays signed meta-transactions (acknowledgements)                             | A gas account                                        |
| Shopify connector | `services/shopify` | The Shopify app's server side                                                  | The app's client secret                              |
| MCP server        | `services/mcp`     | Tools for AI agents                                                            | Nothing: refuses any key                             |
| CLI               | `services/cli`     | JSON-first command line                                                        | The caller's API key                                 |

## How payments are noticed

The API follows each live pay session's status with NEAR Intents every 5 seconds, until an hour after its deadline. When money moves it tells the watcher, which reads that one claim and books what is on its account. A transfer sent by hand to a claim account, outside the provider, is booked by the watcher's daily sweep, or at once by anyone calling `reconcile`.

If the provider's status endpoint refuses, the API pauses for a minute; the payer's page keeps asking on its own.

## RPC and limits

NEAR RPC calls go through a list of endpoints with fallbacks and a daily budget by priority, so bookings and payouts are served before background reads. When every endpoint is over quota, the API answers `503 rpc_busy` with `retry_after`. A call the contract refuses is retried with a growing wait (minutes, doubling to six hours), so a stuck call cannot drain a gas account.

## Deploy

The services ship as one server pack (`openrail-server-<version>.tar.gz`) built by CI, with a systemd unit per service and an env file each, behind Caddy. The human operator runs every deploy and every mainnet step.
