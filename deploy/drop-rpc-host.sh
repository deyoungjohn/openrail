#!/usr/bin/env bash
# Remove one RPC host from every service env file, for example the deprecated public endpoint:
#
#   sudo deploy/drop-rpc-host.sh rpc.mainnet.near.org --dry-run     # show what would go
#   sudo deploy/drop-rpc-host.sh rpc.mainnet.near.org               # do it
#   deploy/drop-rpc-host.sh rpc.mainnet.near.org --dry-run /tmp/etc  # another folder than /etc/openrail
#
# It deletes the lines `NEAR_RPC_URL`, `NEAR_RPC_URL_FALLBACK`, `NEAR_RPC_URL_FALLBACK_1`, `_2`, `1`, `2` ... whose URL
# is on that host, in each `<folder>/*.env`, and touches nothing else (file owner and mode stay). It prints names
# and the host only, never a whole URL (a URL can carry a key). A file whose NEAR_RPC_URL itself would go is
# refused: put the new primary in first, so no service is left without an RPC. Restart the services afterwards.
set -euo pipefail

host=""
dry=0
dir="/etc/openrail"
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    -*) echo "usage: drop-rpc-host.sh <host> [--dry-run] [folder]" >&2; exit 2 ;;
    *) if [[ -z "$host" ]]; then host="$arg"; else dir="$arg"; fi ;;
  esac
done
[[ -n "$host" ]] || { echo "usage: drop-rpc-host.sh <host> [--dry-run] [folder]" >&2; exit 2; }
[[ -d "$dir" ]] || { echo "NOT_FOUND: $dir" >&2; exit 1; }

python3 -I - "$host" "$dry" "$dir" <<'PY'
import glob, os, re, sys

host, dry, folder = sys.argv[1], sys.argv[2] == "1", sys.argv[3]
line_re = re.compile(r"^(NEAR_RPC_URL(?:_FALLBACK)?[_0-9]*)=(.*)$")

def host_of(value: str) -> str:
    value = value.strip().strip('"').strip("'")
    m = re.match(r"^[a-z]+://([^/:?#]+)", value, re.I)
    return (m.group(1) if m else value.split("/")[0]).lower()

plan = []
refused = []
for path in sorted(glob.glob(os.path.join(folder, "*.env"))):
    kept, dropped = [], []
    for line in open(path, encoding="utf-8").read().split("\n"):
        m = line_re.match(line)
        if m and host_of(m.group(2)) == host.lower():
            dropped.append(m.group(1))
        else:
            kept.append(line)
    if not dropped:
        continue
    if "NEAR_RPC_URL" in dropped:
        refused.append(os.path.basename(path))
        continue
    plan.append((path, kept, dropped))

for name in refused:
    print(f"REFUSED {name}: its NEAR_RPC_URL is on {host}; put the new primary there first", file=sys.stderr)
if not plan and not refused:
    print(f"nothing on {host} in {folder}/*.env")
for path, kept, dropped in plan:
    print(f"{os.path.basename(path)}: {'would remove' if dry else 'removed'} {', '.join(dropped)} ({host})")
    if not dry:
        with open(path, "w", encoding="utf-8") as handle:  # same inode: owner and mode stay
            handle.write("\n".join(kept))
if plan and not dry:
    print("Restart the services that read these files, for example: sudo systemctl restart openrail-api openrail-watcher openrail-issuer openrail-indexer openrail-payout")
sys.exit(1 if refused else 0)
PY
