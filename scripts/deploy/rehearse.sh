#!/usr/bin/env bash
# Run the deploy runbook against the local NEAR sandbox.
# Read-only outside the sandbox: no mainnet connection and no secrets printed.
set -euo pipefail
cd "$(dirname "$0")/../.."

export NEAR_SANDBOX_BIN_PATH="${NEAR_SANDBOX_BIN_PATH:-$HOME/.near/sandbox}"
if [[ ! -x "$NEAR_SANDBOX_BIN_PATH" ]]; then
  echo "MISSING_SANDBOX: set NEAR_SANDBOX_BIN_PATH to the near-sandbox binary" >&2
  exit 1
fi

echo "$ scripts/contract.sh"
scripts/contract.sh >/dev/null
cargo run -q -p openrail-tests --bin rehearse
