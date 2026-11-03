#!/usr/bin/env bash
set -euo pipefail

# scripts/gate-run.sh
# Nightly gate run script for Phase 1 (G1):
# 1. Proptests (1,000 cases with recorded seed)
# 2. Scale suite (5,000 claims)
# 3. Mutation spot checks (model & contract)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export CARGO_TERM_COLOR=always
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-6}"
export RUST_TEST_THREADS="${RUST_TEST_THREADS:-4}"

# Configurable gate targets
export PROPTEST_CASES="${PROPTEST_CASES:-1000}"
export SCALE_CLAIMS="${SCALE_CLAIMS:-5000}"

# Record or generate 32-byte hex seed (64 chars) for proptest reproducibility
if [ -z "${PROPTEST_SEED:-}" ]; then
  if command -v xxd >/dev/null 2>&1; then
    export PROPTEST_SEED="$(head -c 32 /dev/urandom | xxd -p -c 32)"
  else
    export PROPTEST_SEED="$(od -vN "32" -An -tx1 /dev/urandom | tr -d " \n")"
  fi
fi

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
echo "  Proptest seed  : $PROPTEST_SEED"
echo "  TMPDIR         : $TMPDIR"
echo "=========================================================="

START_TIME=$(date +%s)

# 0. Ensure fresh contract wasm artifact is compiled
echo ""
echo "=== [0/3] Building contract WASM ==="
cargo near build non-reproducible-wasm --manifest-path contracts/openrail/Cargo.toml

# 1. Proptest 1,000 cases
echo ""
echo "=== [1/3] Running proptests (1,000 cases, seed: $PROPTEST_SEED) ==="
cargo test -p openrail-model --test proptest_invariants -- --nocapture

# 2. Scale suite at 5,000 claims
echo ""
echo "=== [2/3] Running scale suite (5,000 claims) ==="
cargo test -p openrail-tests --test scale_suite -- --nocapture

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
echo "  Seed: $PROPTEST_SEED"
echo "  Proptest cases: $PROPTEST_CASES"
echo "  Scale claims: $SCALE_CLAIMS"
echo "  All invariant and mutation checks PASSED."
echo "=========================================================="
