#!/usr/bin/env bash
# Run once on your laptop. Creates ~/.openrail/openrail.env (mode 600), the one file every script reads:
# builds, the deploy plan, uploads, and the server's env. Secrets are copied from the GNOME keyring
# with shell builtins only, so no secret appears in a process list or in your shell history.
set -euo pipefail
cd "$(dirname "$0")/.."

file="${OPENRAIL_ENV:-$HOME/.openrail/openrail.env}"
if [[ -e "$file" ]]; then
  echo "EXISTS: $file. Edit it with: nano $file   (delete it first to start over)" >&2
  exit 1
fi
umask 077
mkdir -p "$(dirname "$file")"
chmod 700 "$(dirname "$file")"
cp deploy/env/openrail.env.example "$file"

fill() { # fill NAME VALUE: set the line NAME= in the file without passing VALUE to any program
  local name="$1" value="$2" tmp line
  tmp="$(mktemp)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$name="* ]]; then printf '%s=%s\n' "$name" "$value"; else printf '%s\n' "$line"; fi
  done <"$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

keyring() { # keyring ITEM: print a keyring secret, or stop if it is missing
  local v
  v="$(secret-tool lookup service openrail name "$1" 2>/dev/null || true)"
  [[ -n "$v" ]] || { echo "MISSING_KEYRING_ITEM: $1" >&2; rm -f "$file"; exit 1; }
  printf '%s' "$v"
}

fill ISSUER_PRIVATE_KEY "$(keyring issuer-fc-key)"
fill RELAY_PRIVATE_KEY "$(keyring relayer-fc-key)"
fill WATCHER_PRIVATE_KEY "$(keyring watcher-fc-key)"
fill ISSUER_SERVICE_KEY "$(openssl rand -hex 32)"
fill NEXT_PUBLIC_API_PUBLISHABLE_KEY "or_pk_live_$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"

ask() { # ask NAME "question" [secret]
  local answer
  if [[ "${3:-}" == secret ]]; then read -r -s -p "$2: " answer; echo; else read -r -p "$2: " answer; fi
  fill "$1" "$answer"
}
ask SERVER_IP "EC2 public IP"
ask SSH_KEY_FILE "SSH private key file (for example $HOME/.ssh/openrail.pem)"
ask NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID "WalletConnect project ID (cloud.reown.com)"
ask ONECLICK_JWT "1Click JWT (hidden)" secret
ask NEARBLOCKS_API_KEY "NearBlocks API key (hidden)" secret

echo "created $file (mode 600). Edit any value later with: nano $file"
