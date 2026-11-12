#!/usr/bin/env bash
# One command that says what is wrong on the server, with no secret in the output.
#
#   sudo bash /opt/openrail/current/deploy/doctor.sh | tee /tmp/doctor.txt
#
# It prints: which services run, each service's health, which settings are present (names only, never values), the
# event files the indexer reads, and the last errors of each service. Paste /tmp/doctor.txt to whoever is helping.
set -uo pipefail

section() { printf '\n=== %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

section "time and build"
date -u +"now (UTC): %Y-%m-%d %H:%M:%S"
readlink -f /opt/openrail/current 2>/dev/null || true
ls -1 /opt/openrail/current/.pack-commit /opt/openrail/current/PACK_COMMIT 2>/dev/null | head -1 | xargs -r cat

section "services"
for u in api issuer watcher indexer web payout shopify; do
  state="$(systemctl is-active "openrail-$u" 2>/dev/null || true)"
  printf '%-10s %s\n' "$u" "${state:-not installed}"
done

section "health"
for pair in "watcher:8080" "indexer:8788" "payout:8082" "api:3001/v1/health"; do
  name="${pair%%:*}"; target="${pair#*:}"
  case "$target" in */*) url="http://127.0.0.1:$target" ;; *) url="http://127.0.0.1:$target/health" ;; esac
  printf -- '--- %s (%s)\n' "$name" "$url"
  curl -s -m 8 "$url" | head -c 1800 || echo "(no answer)"
  echo
done

section "settings present (names only)"
check() { # file name...
  local f="$1"; shift
  [[ -r "$f" ]] || { echo "$f: not readable (run with sudo)"; return; }
  for n in "$@"; do
    if grep -qE "^${n}=.+" "$f"; then echo "$f  $n = set"; else echo "$f  $n = MISSING or empty"; fi
  done
}
check /etc/openrail/watcher.env NEAR_RPC_URL WATCHER_DB_PATH INDEXER_URL
check /etc/openrail/indexer.env INDEXER_EVENT_SOURCES INDEXER_FROM INDEXER_POLL_INTERVAL_MS INDEXER_MAX_PAGES NEARBLOCKS_API_KEY NEARBLOCKS_API_KEY_2
check /etc/openrail/payout.env NEAR_RPC_URL PAYOUT_DB_PATH PAYOUT_API_URL PAYOUT_INTERNAL_KEY INDEXER_URL
check /etc/openrail/api.env QUOTE_MARGIN_BPS CONFIDENTIAL_INTENTS ONECLICK_JWT WATCHER_URL

section "event files the indexer reads (owner, mode, size, newest row)"
ls -l /var/lib/openrail/*.sqlite 2>/dev/null || echo "no sqlite files in /var/lib/openrail"
if have sqlite3; then
  for f in /var/lib/openrail/watcher.sqlite /var/lib/openrail/payout.sqlite; do
    [[ -r "$f" ]] && { printf '%s events: ' "$f"; sqlite3 "file:$f?mode=ro" "select count(*), max(timestamp) from events" 2>&1 | head -1; }
  done
fi

section "last errors (20 lines each, last 30 minutes)"
for u in watcher indexer payout api issuer; do
  printf -- '--- openrail-%s\n' "$u"
  journalctl -u "openrail-$u" --since "-30 min" --no-pager -p warning 2>/dev/null | tail -20
done

section "network (IPv4 first matters: a 'fetch failed' on every RPC at once)"
for u in https://free.rpc.fastnear.com https://1click.chaindefuser.com/v0/tokens https://api.nearblocks.io; do
  printf '%s -> ' "$u"; curl -s -m 10 -o /dev/null -w '%{http_code}\n' "$u" || echo "no answer"
done
grep -h "NODE_OPTIONS" /etc/systemd/system/openrail-*.service 2>/dev/null | sort | uniq -c
