#!/usr/bin/env bash
# Makes one RPC URL the primary (NEAR_RPC_URL) in every service env file, keeping the old primary as a fallback.
#
#   sudo bash /opt/openrail/current/deploy/set-primary-rpc.sh [--dry-run] [--file ~/.openrail/openrail.env] [--match quiknode]
#
# The URL is read from the given env file (default ~/.openrail/openrail.env): the first variable whose value contains
# the --match text (default "quiknode"), NEAR_RPC_URL first. The URL is a secret: it is never printed (only its host).
# For each of watcher, payout, indexer, api, issuer in /etc/openrail:
#   - a copy is saved as <file>.bak.<time>
#   - the URL's old fallback line (if any) is removed, the current NEAR_RPC_URL moves to the first free
#     NEAR_RPC_URL_FALLBACK_1..9 (unless it is already there), and NEAR_RPC_URL becomes the new URL.
# Restart the services afterwards:  sudo systemctl restart openrail-watcher openrail-payout openrail-indexer openrail-api openrail-issuer
set -euo pipefail

dry=0
file="${HOME:-/root}/.openrail/openrail.env"
match="quiknode"
dir="/etc/openrail"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --file) file="$2"; shift ;;
    --match) match="$2"; shift ;;
    --dir) dir="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
# sudo changes $HOME: when run with sudo, prefer the invoking user's file.
if [[ ! -r "$file" && -n "${SUDO_USER:-}" ]]; then
  file="$(getent passwd "$SUDO_USER" | cut -d: -f6)/.openrail/openrail.env"
fi
[[ -r "$file" ]] || { echo "cannot read $file (use --file PATH)"; exit 2; }

exec python3 -I - "$file" "$match" "$dir" "$dry" <<'PY'
import os, re, sys, time, shutil
from urllib.parse import urlparse

source, match, folder, dry = sys.argv[1], sys.argv[2].lower(), sys.argv[3], sys.argv[4] == "1"

def read_env(path):
    out = {}
    for raw in open(path, encoding="utf-8").read().splitlines():
        line = raw.strip().rstrip("\r")
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out

values = read_env(source)
url = None
candidates = ["NEAR_RPC_URL"] + [k for k in values if k != "NEAR_RPC_URL"]
for k in candidates:
    v = values.get(k, "")
    if v.startswith("http") and match in v.lower():
        url = v
        break
if url is None:
    print(f"no variable in {source} has a URL containing '{match}'")
    sys.exit(2)
host = urlparse(url).hostname or "?"
print(f"new primary: host {host} (URL not shown)")

def key_of(line):
    m = re.match(r"^\s*([A-Za-z0-9_]+)=(.*)$", line)
    return (m.group(1), m.group(2).strip().strip('"').strip("'")) if m else (None, None)

FALLBACKS = ["NEAR_RPC_URL_FALLBACK"] + [f"NEAR_RPC_URL_FALLBACK_{n}" for n in range(1, 10)] + [f"NEAR_RPC_URL_FALLBACK{n}" for n in range(1, 10)]
stamp = time.strftime("%Y%m%d-%H%M%S")
changed = 0
for name in ("watcher", "payout", "indexer", "api", "issuer"):
    path = os.path.join(folder, f"{name}.env")
    if not os.path.exists(path):
        print(f"{name}: no file, skipped")
        continue
    lines = open(path, encoding="utf-8").read().splitlines()
    out, old_primary, kept = [], None, set()
    for line in lines:
        k, v = key_of(line)
        if k == "NEAR_RPC_URL":
            old_primary = v
            continue
        if k in FALLBACKS and v == url:
            continue  # the new primary no longer needs a fallback line
        if k in FALLBACKS:
            kept.add(k)
        out.append(line)
    existing_values = {key_of(l)[1] for l in out if key_of(l)[0] in FALLBACKS}
    if old_primary and old_primary != url and old_primary not in existing_values:
        free = next((f"NEAR_RPC_URL_FALLBACK_{n}" for n in range(1, 10) if f"NEAR_RPC_URL_FALLBACK_{n}" not in kept), None)
        if free is None:
            print(f"{name}: all nine fallback slots are used; the old primary is dropped")
        else:
            out.append(f"{free}={old_primary}")
    out.append(f"NEAR_RPC_URL={url}")
    if dry:
        print(f"{name}: would set the primary ({'old primary kept as a fallback' if old_primary and old_primary != url else 'no old primary to keep'})")
        continue
    shutil.copy2(path, f"{path}.bak.{stamp}")
    mode = os.stat(path).st_mode & 0o777
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(out) + "\n")
    os.chmod(path, mode)
    changed += 1
    print(f"{name}: primary set, backup {os.path.basename(path)}.bak.{stamp}")
print("dry run, nothing written" if dry else f"{changed} file(s) changed. Restart the services.")
PY
