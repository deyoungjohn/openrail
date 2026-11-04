#!/usr/bin/env bash
# Runs scripts/gate-run.sh, captures its output, and writes evidence/gate-g1-<UTC date>.md
# mechanically from that output (see scripts/gate-evidence.ts). Exits with the gate's status.
set -uo pipefail
cd "$(dirname "$0")/.."
LOG="$(mktemp)"
START=$(date +%s)
scripts/gate-run.sh 2>&1 | tee "$LOG"
CODE=${PIPESTATUS[0]}
ELAPSED=$(( $(date +%s) - START ))
pnpm exec tsx scripts/gate-evidence.ts "$LOG" "$CODE" "$ELAPSED"
rm -f "$LOG"
exit "$CODE"
