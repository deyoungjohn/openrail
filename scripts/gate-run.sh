#!/usr/bin/env bash
set -euo pipefail

# scripts/gate-run.sh
# Nightly gate run script for Phase 1 (G1):
# 1. Proptests (1,000 cases)
# 2. Scale suite (5,000 claims, timed)
# 3. Mutation spot checks (model & contract)
# 4. Deploy rehearsal on the local sandbox

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export CARGO_TERM_COLOR=always
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-6}"
export RUST_TEST_THREADS="${RUST_TEST_THREADS:-4}"

# Configurable gate targets
export PROPTEST_CASES="${PROPTEST_CASES:-1000}"
export SCALE_CLAIMS="${SCALE_CLAIMS:-5000}"

# Set isolated tmpdir for sandbox locks if TMPDIR is not set
if [ -z "${TMPDIR:-}" ]; then
  export TMPDIR="/tmp/openrail-gate-run-$$"
  mkdir -p "$TMPDIR"
  trap 'rm -rf "$TMPDIR"' EXIT
fi

echo "=========================================================="
echo "Starting OpenRail Phase 1 Gate Run"
echo "  Proptest cases : $PROPTEST_CASES"
echo "  Scale claims   : $SCALE_CLAIMS"
echo "  TMPDIR         : $TMPDIR"
echo "=========================================================="

START_TIME=$(date +%s)

# 0. Ensure fresh contract wasm artifact is compiled
echo ""
echo "=== [0/4] Building contract WASM ==="
cargo near build non-reproducible-wasm --manifest-path contracts/openrail/Cargo.toml

# 1. Proptest 1,000 cases
echo ""
echo "=== [1/4] Running proptests ($PROPTEST_CASES cases) ==="
PROP_START=$(date +%s)
cargo test -p openrail-model --test proptest_invariants -- --nocapture
PROP_END=$(date +%s)
PROP_ELAPSED=$((PROP_END - PROP_START))
echo "Proptests completed in ${PROP_ELAPSED}s"

# 2. Scale suite at 5,000 claims (timed)
echo ""
echo "=== [2/4] Running scale suite ($SCALE_CLAIMS claims) ==="
SCALE_START=$(date +%s)
cargo test -p openrail-tests --test scale_suite -- --nocapture
SCALE_END=$(date +%s)
SCALE_ELAPSED=$((SCALE_END - SCALE_START))
echo "Scale suite completed in ${SCALE_ELAPSED}s"

# 3. Mutation spot checks
echo ""
echo "=== [3/4] Running mutation spot checks ==="
echo "--> Model mutation checks (5 deliberate breaks):"
cargo test -p openrail-model --test mutation_checks -- --nocapture

echo "--> Contract sandbox mutation checks (5 deliberate breaks):"
cargo test -p openrail-tests --test mutation_tests -- --nocapture

# 4. Deploy rehearsal: deploy/new, keys, issuer, mock payment, watcher, indexer
echo ""
echo "=== [4/4] Running deploy rehearsal ==="
if [[ -z "${NEAR_SANDBOX_BIN_PATH:-}" && -x "$HOME/.near/sandbox" ]]; then
  export NEAR_SANDBOX_BIN_PATH="$HOME/.near/sandbox"
fi
scripts/deploy/rehearse.sh

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo "=========================================================="
echo "Gate Run Successful in ${ELAPSED}s"
echo "  Proptest cases : $PROPTEST_CASES (${PROP_ELAPSED}s)"
echo "  Scale claims   : $SCALE_CLAIMS (${SCALE_ELAPSED}s)"
echo "  All invariant, mutation, and deploy rehearsal checks PASSED."
echo "=========================================================="
