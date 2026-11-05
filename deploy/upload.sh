#!/usr/bin/env bash
# Laptop: copy the newest server pack (dist/openrail-server-*.tar.gz) to the server's home folder.
#   deploy/upload.sh          copy the pack
#   deploy/upload.sh --env    also copy the env file (needed the first time and whenever it changes)
#   deploy/upload.sh --env-only   copy only the env file (a changed key or setting; no new build needed)
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=deploy/lib/load-env.sh
. deploy/lib/load-env.sh
load_openrail_env SERVER_IP SSH_KEY_FILE

: "${SERVER_IP:?MISSING_ENV: SERVER_IP}"
: "${SSH_KEY_FILE:?MISSING_ENV: SSH_KEY_FILE}"
env_file="${OPENRAIL_ENV:-$HOME/.openrail/openrail.env}"
files=()
if [[ "${1:-}" != "--env-only" ]]; then
  pack="$(ls -t dist/openrail-server-*.tar.gz 2>/dev/null | head -1 || true)"
  [[ -n "$pack" ]] || { echo "NO_PACK: run deploy/build.sh first" >&2; exit 1; }
  files+=("$pack")
fi
if [[ "${1:-}" == "--env" || "${1:-}" == "--env-only" ]]; then files+=("$env_file"); fi
echo "uploading ${files[*]} to ubuntu@$SERVER_IP"
scp -i "$SSH_KEY_FILE" "${files[@]}" "ubuntu@$SERVER_IP:~/"
echo "done."
