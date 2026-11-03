#!/usr/bin/env bash
# Local-only health check for the systemd services behind Caddy.
set -uo pipefail

failures=0

check_http() {
  local name="$1"
  local url="$2"
  if curl -fsS --max-time 5 "$url" >/dev/null; then
    echo "ok   $name $url"
  else
    echo "FAIL $name $url" >&2
    failures=$((failures + 1))
  fi
}

check_unit() {
  local unit="$1"
  if systemctl is-active --quiet "$unit"; then
    echo "ok   $unit"
  else
    echo "FAIL $unit is not active" >&2
    failures=$((failures + 1))
  fi
}

check_unit openrail-web.service
check_unit openrail-api.service
check_unit openrail-watcher.service
check_unit openrail-issuer.service
check_unit caddy.service

if systemctl is-enabled --quiet openrail-indexer.service 2>/dev/null; then
  check_unit openrail-indexer.service
fi
if systemctl is-enabled --quiet openrail-backup.timer 2>/dev/null; then
  check_unit openrail-backup.timer
fi

check_http web http://127.0.0.1:3000/
check_http api http://127.0.0.1:3001/v1/health
check_http watcher http://127.0.0.1:8080/health
check_http issuer http://127.0.0.1:8787/health

if [[ "$failures" -ne 0 ]]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
