#!/usr/bin/env bash
# Owner: P0.3. Builds the root contract with cargo-near (blueprint 1.5.2) for the enabled modules.
# Usage: scripts/contract.sh [comma-separated features]   (default: enabled modules)
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
features="${1-$(scripts/enabled-features)}"
args=(non-reproducible-wasm --manifest-path contracts/openrail/Cargo.toml)
[ -n "$features" ] && args+=(--features "$features")
exec cargo near build "${args[@]}"
