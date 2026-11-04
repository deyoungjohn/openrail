#!/usr/bin/env bash
# Runs scripts/gate-run.sh, captures its output, and writes evidence/gate-g1-<UTC date>.md
# mechanically from that output (see scripts/gate-evidence.ts). Exits with the gate's status.
# The output goes to a file (not a pipe) so a stray child process of a stage cannot keep this
# script waiting after the gate itself has finished.
set -uo pipefail
cd "$(dirname "$0")/.."
LOG="$(mktemp)"
START=$(date +%s)
scripts/gate-run.sh >"$LOG" 2>&1 &
GATE_PID=$!
tail -n +1 -f --pid="$GATE_PID" "$LOG" &
wait "$GATE_PID"
CODE=$?
sleep 1
ELAPSED=$(( $(date +%s) - START ))
pnpm exec tsx scripts/gate-evidence.ts "$LOG" "$CODE" "$ELAPSED"
rm -f "$LOG"
exit "$CODE"
