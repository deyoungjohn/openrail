#!/usr/bin/env bash
set -euo pipefail

# scripts/gate-run.sh
# Nightly gate run script for Phase 1 (G1):
# 1. Proptests (1,000 cases)
# 2. Scale suite (5,000 claims, timed)
# 3. Mutation spot checks (model & contract)

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
echo "=== [0/3] Building contract WASM ==="
cargo near build non-reproducible-wasm --manifest-path contracts/openrail/Cargo.toml

# 1. Proptest 1,000 cases
echo ""
echo "=== [1/3] Running proptests ($PROPTEST_CASES cases) ==="
PROP_START=$(date +%s)
cargo test -p openrail-model --test proptest_invariants -- --nocapture
PROP_END=$(date +%s)
PROP_ELAPSED=$((PROP_END - PROP_START))
echo "Proptests completed in ${PROP_ELAPSED}s"

# 2. Scale suite at 5,000 claims (timed)
echo ""
echo "=== [2/3] Running scale suite ($SCALE_CLAIMS claims) ==="
SCALE_START=$(date +%s)
cargo test -p openrail-tests --test scale_suite -- --nocapture
SCALE_END=$(date +%s)
SCALE_ELAPSED=$((SCALE_END - SCALE_START))
echo "Scale suite completed in ${SCALE_ELAPSED}s"

# 3. Mutation spot checks
echo ""
echo "=== [3/3] Running mutation spot checks ==="
echo "--> Model mutation checks (5 deliberate breaks):"
cargo test -p openrail-model --test mutation_checks -- --nocapture

echo "--> Contract sandbox mutation checks (5 deliberate breaks):"
cargo test -p openrail-tests --test mutation_tests -- --nocapture

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo "=========================================================="
echo "Gate Run Successful in ${ELAPSED}s"
echo "  Proptest cases : $PROPTEST_CASES (${PROP_ELAPSED}s)"
echo "  Scale claims   : $SCALE_CLAIMS (${SCALE_ELAPSED}s)"
echo "  All invariant and mutation checks PASSED."
echo "=========================================================="
