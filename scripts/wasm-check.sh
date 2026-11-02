#!/usr/bin/env bash
# wasm import gate (blueprint 1.5 rule 1, 3.3).
# Checks every wasm produced by `make contract` and by the vault build:
#   - fails on any import matching gas_key|universal_state
#   - prints the size of every checked wasm
# Also runs a self-test with a hand-made wasm that has a banned import.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

node scripts/wasm-check.mjs --self-test

openrail_wasm="target/near/openrail/openrail.wasm"
if [ ! -f "$openrail_wasm" ]; then
  echo "wasm-check: missing $openrail_wasm (run make contract first)" >&2
  exit 1
fi

# The vault is a separate build (P0.4). Build it so the gate covers it every time.
if command -v cargo-near >/dev/null 2>&1; then
  cargo near build non-reproducible-wasm --no-abi \
    --manifest-path contracts/vault/Cargo.toml >/dev/null
else
  echo "wasm-check: cargo-near not found; building the vault with cargo --cfg near" >&2
  RUSTFLAGS="--cfg near" cargo build --release --target wasm32-unknown-unknown \
    --manifest-path contracts/vault/Cargo.toml >/dev/null
  mkdir -p target/near/openrail_vault
  cp target/wasm32-unknown-unknown/release/openrail_vault.wasm \
    target/near/openrail_vault/openrail_vault.wasm
fi
vault_wasm="target/near/openrail_vault/openrail_vault.wasm"
if [ ! -f "$vault_wasm" ]; then
  echo "wasm-check: missing $vault_wasm after the vault build" >&2
  exit 1
fi

node scripts/wasm-check.mjs "$openrail_wasm" "$vault_wasm"
echo "wasm-check: OK"
