# Deploy dry run

`scripts/deploy/plan.sh` builds the production wasm and prints the commands a human runs. It never signs, sends, or reads a private key. The only values it reads are account IDs, public keys, the routes file, and the built wasm.

## Prerequisites

- Docker (the build runs in the pinned `sourcescan/cargo-near` image)
- `cargo-near` and `near-cli-rs`
- a clean, committed branch (reproducible builds require it)
- run from the primary checkout, not a linked worktree (cargo-near resolves the repo root from `.git`)
- Node.js 22+ and `pnpm`

## Environment (public values only)

| Variable | Meaning | Default |
|---|---|---|
| `NEAR_ROOT_ACCOUNT` | deployed root account | `openrail.near` |
| `NEAR_ENV` | `mainnet` or `testnet` | `mainnet` |
| `FEE_ACCOUNT` | fee recipient | `fees.openrail.near` |
| `VAULT_GLOBAL_HASH` | base58 vault code hash | `HXX9ic98ura2nYQqGxgpT1BMiUgWNogMWZEq5UbejU5r` |
| `WATCHERS` | comma-separated watcher accounts | falls back to `WATCHER_ACCOUNT_ID` |
| `WATCHER_ACCOUNT_ID` | account that receives the watcher key | — |
| `WATCHER_PUBLIC_KEY` | watcher function-call public key | required |
| `ISSUERS` | comma-separated issuer accounts | falls back to `ISSUER_ACCOUNT_ID` |
| `ISSUER_ACCOUNT_ID` | account that receives the issuer key | — |
| `ISSUER_PUBLIC_KEY` | issuer function-call public key | required |
| `QUOTE_WRITERS` | comma-separated quote writers | falls back to `ISSUER_ACCOUNT_ID` |
| `RELAYER_ACCOUNT_ID` | account that receives the acknowledgement key | required |
| `RELAYER_PUBLIC_KEY` | relayer function-call public key | required |
| `WATCHER_KEY_ALLOWANCE_NEAR` | watcher key allowance | `1 NEAR` |
| `ISSUER_KEY_ALLOWANCE_NEAR` | issuer key allowance | `1 NEAR` |
| `RELAYER_KEY_ALLOWANCE_NEAR` | relayer key allowance | `0.5 NEAR` |
| `ACCOUNT_BALANCE_NEAR` | optional current signer balance; plan stops if a key allowance exceeds it | — |

Never export a private key for this script. It only needs public keys; the near CLI asks the human to sign.

## Steps

1. Run the read-only plan:

   ```bash
   scripts/deploy/plan.sh
   ```

   → build output, wasm size, sha256 in hex and base58, and the full command list.
   → `SKIP_BUILD=1 scripts/deploy/plan.sh` reuses `target/near/openrail/openrail.wasm`.

2. Review the printed `Config`:
   - `settlement_assets` comes from `config/routes.json` (unique values, source order).
   - `vault_code_hash` is the base58 value converted to the hex form the contract stores.
   - `fee_account`, `watchers`, `issuers`, `quote_writers` come from the environment above.

3. The human runs the printed commands from the repository root:
   - deploy + `new` initialization;
   - `set_config` for an existing deployment;
   - `near account add-key` for watcher, issuer, and relayer public keys.

4. Verify:

   ```bash
   near contract call-function as-read-only openrail.near config json-args '{}' network-config mainnet now
   near contract call-function as-read-only openrail.near contract_source_metadata json-args '{}' network-config mainnet now
   ```

   → `config` must match the printed JSON.
   → `contract_source_metadata` returns the reproducible-build metadata.

## Key scopes

| Key | Methods |
|---|---|
| watcher | `reconcile`, `retry_distribution`, `clear_stale_lock` |
| issuer | `issue_for`, `log_quote` |
| relayer | `acknowledge_evm` |

The reproducible build pins its Rust image and feature list in `contracts/openrail/Cargo.toml`. If `openrail.modules.json` changes, update the `--features` value there; `plan.ts` stops when the two lists differ.

## Sandbox rehearsal

`scripts/deploy/rehearse.sh` runs the runbook against the local NEAR sandbox: deploy + `new`, add the issuer/relay/watcher function-call keys, issue one invoice through the real issuer service, pay it through the mock intents contract, reconcile with the watcher key, and read the receipt from the real indexer service. It prints every equivalent command and the final receipt JSON; no mainnet connection and no secrets are printed.

```bash
NEAR_SANDBOX_BIN_PATH="$HOME/.near/sandbox" scripts/deploy/rehearse.sh
```

→ prints the sandbox RPC URL, the deploy/config command, the three `add-key` commands, the issuer `curl`, the mock `mt_mint` and `reconcile` calls, and the indexer receipt.
→ exits non-zero if any service, transaction, or receipt step fails.

Prerequisites: `cargo`, `pnpm`, `curl`, and the `near-sandbox` binary. The script rebuilds `target/near/openrail/openrail.wasm` from the current checkout first, so a stale wasm cannot mask a failure. The human then runs the `scripts/deploy/plan.sh` commands against mainnet.
