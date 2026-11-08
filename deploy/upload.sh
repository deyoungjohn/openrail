#!/usr/bin/env bash
# Laptop: copy the newest server pack (dist/openrail-server-*.tar.gz) to the server's home folder.
#   deploy/upload.sh                 copy the pack
#   deploy/upload.sh --env           also copy the env file (needed the first time and whenever it changes)
#   deploy/upload.sh --env-only      copy only the env file (a changed key or setting; no new build needed)
#   deploy/upload.sh --dry-run       print the scp command, transfer nothing
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=deploy/lib/load-env.sh
# shellcheck disable=SC1091
. deploy/lib/load-env.sh
load_openrail_env SERVER_IP SSH_KEY_FILE

dry=0
want_pack=1
want_env=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --env) want_env=1 ;;
    --env-only) want_pack=0; want_env=1 ;;
    -h|--help) sed -n 2,8p "$0"; exit 0 ;;
    *) echo "UNKNOWN_ARG: $arg" >&2; exit 2 ;;
  esac
done

: "${SERVER_IP:?MISSING_ENV: SERVER_IP}"
: "${SSH_KEY_FILE:?MISSING_ENV: SSH_KEY_FILE}"
env_file="${OPENRAIL_ENV:-$HOME/.openrail/openrail.env}"
files=()
if [[ "$want_pack" == 1 ]]; then
  pack="$(find dist -maxdepth 1 -name 'openrail-server-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
  [[ -n "$pack" ]] || { echo "NO_PACK: run deploy/build.sh first" >&2; exit 1; }
  files+=("$pack")
fi
if [[ "$want_env" == 1 ]]; then
  [[ -f "$env_file" ]] || { echo "MISSING_ENV_FILE: $env_file" >&2; exit 1; }
  files+=("$env_file")
fi
if [[ "$dry" == 1 ]]; then
  printf 'scp -i %q' "$SSH_KEY_FILE"
  for file in "${files[@]}"; do printf ' %q' "$file"; done
  printf ' %q\n' "ubuntu@$SERVER_IP:~/"
  exit 0
fi
echo "uploading ${files[*]} to ubuntu@$SERVER_IP"
scp -i "$SSH_KEY_FILE" "${files[@]}" "ubuntu@$SERVER_IP:~/"
echo "done."
