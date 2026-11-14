# Run locally

Run the web app against a mock API in a couple of minutes, or the whole stack against a NEAR sandbox.

## Requirements

- Node.js 22 and pnpm
- Rust (the version in `rust-toolchain.toml`) and `cargo-near`, for the contract
- No keys for the mock; real keys only in environment variables

## The app on the mock API

```bash Shell
git clone https://github.com/deyoungjohn/openrail.git
cd openrail
pnpm install
cp .env.example .env            # variable names only; values are never committed

# terminal 1: the mock API (fixtures, no chain)
MOCK=1 pnpm --filter @openrail/api start

# terminal 2: the web app
pnpm --filter @openrail/web dev
```

Open `http://localhost:3000`. In mock mode, **Sign in** signs in a fixture business, and every page has data.

## The contract

```bash Shell
make contract     # build the wasm with cargo near
make wasm-check   # check host imports for protocol 86
```

## The whole stack

`make test` runs the contract's sandbox suite and every service against a local NEAR sandbox: issuing, paying (with the provider simulated), booking, transfers and payouts. The e2e harness in `services/web/e2e/stack` starts the sandbox, the issuer, the indexer, the API and the web app together.

## Environment

Services read configuration only from the environment, through one helper. A missing secret stops the service with `MISSING_ENV: <NAME>`; it never falls back to a default. `.env.example` lists every name.

## Modules

Edit `openrail.modules.json`, then:

```bash Shell
pnpm gen:modules
```

A switched-off module disappears from the contract features, the services, the web app and the docs.
