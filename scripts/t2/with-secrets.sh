#!/usr/bin/env bash
# Export named secrets from the GNOME keyring and exec the command.
# Items: OPENRAIL_API_KEY=openrail/api-key, ISSUER_PRIVATE_KEY=openrail/issuer,
#        WATCHER_PRIVATE_KEY=openrail/watcher, ONECLICK_JWT=openrail/oneclick
set -euo pipefail

while IFS='=' read -r name item; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  value="$(secret-tool lookup service openrail name "$item" 2>/dev/null || true)"
  if [[ -z "$value" ]]; then
    echo "MISSING_SECRET: $name" >&2
    exit 2
  fi
  export "$name=$value"
done <<'ITEMS'
OPENRAIL_API_KEY=openrail/api-key
ISSUER_PRIVATE_KEY=openrail/issuer
WATCHER_PRIVATE_KEY=openrail/watcher
ONECLICK_JWT=openrail/oneclick
ITEMS

exec "$@"
