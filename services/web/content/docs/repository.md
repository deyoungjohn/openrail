# Repository map

Where everything lives in [github.com/deyoungjohn/openrail](https://github.com/deyoungjohn/openrail). It is one pnpm and Cargo workspace.

## Top level

| Path                                 | What                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts/openrail`                 | The NEAR contract (Rust) and its module code in `src/modules`                                                                           |
| `contracts/tests`, `contracts/model` | Sandbox tests and the model tests                                                                                                       |
| `services/`                          | Every service: `api`, `web`, `issuer`, `watcher`, `indexer`, `payout`, `relayer`, `shopify`, `mcp`, `cli`                               |
| `packages/`                          | Shared code: `shared` (routes, 1Click client, env), `api-client` (typed client generated from OpenAPI), `node` (SDK), `widget`, `react` |
| `schemas/`, `abi/`                   | Event and API schemas; the contract ABI checked in CI                                                                                   |
| `config/`                            | Routes and settlement assets                                                                                                            |
| `deploy/`                            | The server pack, systemd units, env templates and Caddy                                                                                 |
| `docs/src`                           | The repository's technical docs (core and modules)                                                                                      |
| `evidence/`, `reports/`              | Measured runs: each number in the docs links to one                                                                                     |
| `fixtures/`                          | API and indexer fixtures for the mock and the tests                                                                                     |
| `scripts/`                           | Leak check, secret scan, module generation, gates                                                                                       |
| `openrail.modules.json`              | Which modules are in the build                                                                                                          |

## The web app

| Path                          | What                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/web/src/app`        | Routes: the site (`/`, `/features`, `/use-cases`, `/developers`, `/how-it-works`, `/proof`, `/agents`), the app (`/app/*`), hosted pages (`/pay`, `/c`, `/r`), these docs (`/docs`) |
| `services/web/src/components` | UI: landing, dashboard, pay, setup, shell                                                                                                                                           |
| `services/web/src/modules`    | Module UI, compiled in only when the module is on                                                                                                                                   |
| `services/web/content/docs`   | These pages, in Markdown                                                                                                                                                            |

## Conventions

- Commit messages are `<area>: <what>`; a port from a spike says so.
- Tests are written from the spec before the code they test, and never weakened to make code pass.
- Every number in a public doc links to a report or a run.
