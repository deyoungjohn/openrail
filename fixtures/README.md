# Fixtures

Carried over as data from the pre-build spikes; sources are named in each file.

| File | Source |
|---|---|
| `routes.json` | Spike `data/routes.json`; route probes in `evidence/K2prime-partA-routes-2026-10-29T03-08-53Z.json`. Copied to `config/routes.json`, the typed registry's only data source. |
| `oneclick/quote-response.json` | `evidence/pay-report-2026-10-31T19-13-15-901Z.json` (`quote.signedQuoteResponse`). The provider signature is omitted: fixtures carry no key-shaped data. |
| `oneclick/status-response.json` | `evidence/K8-real-2026-10-28T21-09-46Z.json` (`providerStatus`; `/v0/status` fields are under `swapDetails`). |
| `oneclick/deposit-submit-error.json` | `evidence/pay-report-2026-10-31T19-13-15-901Z.json` timeline (`/v0/deposit/submit 500: Empty AMQP response`). |
| `vectors/*.json` | K14/K15/K3 vectors, carried over by P0.3/P0.4. |

Tests never touch the network: fake transports replay these files.
