#!/usr/bin/env bash
# Server: download a server pack that CI built and published as a GitHub Release, then (optionally) put it live.
# The laptop no longer uploads 250 MB: the server pulls it from GitHub over its own fast connection.
#
#   sudo openrail-fetch                 download the newest pack to the caller's home folder, verify it
#   sudo openrail-fetch <short-sha>     download the pack built from that commit
#   sudo openrail-fetch --apply [sha]   download, verify, then run openrail-apply on it
#   add --dry-run to print what would happen without downloading
#
# First time only:
#   curl -fsSL https://raw.githubusercontent.com/deyoungjohn/openrail/main/deploy/fetch.sh \
#     | sudo tee /usr/local/bin/openrail-fetch >/dev/null && sudo chmod +x /usr/local/bin/openrail-fetch
#
# The repository is public, so no token is needed. Packs carry no secrets (only NEXT_PUBLIC_* values).
set -euo pipefail

REPO="${OPENRAIL_REPO:-deyoungjohn/openrail}"
API="${OPENRAIL_GH_API:-https://api.github.com}"
DL="${OPENRAIL_GH_DL:-https://github.com}"
APPLY_BIN="${OPENRAIL_APPLY:-/usr/local/bin/openrail-apply}"
SELF_COPY="${OPENRAIL_FETCH_SELF:-/usr/local/bin/openrail-fetch}"

apply=0
dry=0
want=""
for arg in "$@"; do
  case "$arg" in
    --apply) apply=1 ;;
    --dry-run) dry=1 ;;
    -h | --help) sed -n 2,12p "$0"; exit 0 ;;
    *) want="$arg" ;;
  esac
done

say() { printf '== %s\n' "$*"; }
for tool in curl sha256sum python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "MISSING_TOOL: $tool" >&2; exit 1; }
done
if [[ -n "$want" && ! "$want" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "BAD_SHA: $want (expected a short or full commit hash)" >&2
  exit 1
fi

# Pick the release: the newest server-* release, or the one for the requested commit.
releases_json="$(curl -fsSL --retry 3 -H 'Accept: application/vnd.github+json' "$API/repos/$REPO/releases?per_page=30")"
tag="$(WANT="$want" python3 -c '
import json, os, sys
want = os.environ["WANT"]
rels = [r for r in json.load(sys.stdin) if r.get("tag_name", "").startswith("server-")]
rels.sort(key=lambda r: r.get("created_at", ""), reverse=True)
for r in rels:
    if not want or r["tag_name"][len("server-"):].startswith(want[:7]):
        print(r["tag_name"]); break
' <<<"$releases_json")"
[[ -n "$tag" ]] || { echo "NO_RELEASE: no server pack release${want:+ for $want} (has the server-pack workflow run?)" >&2; exit 1; }
short="${tag#server-}"
name="openrail-server-${short}.tar.gz"
base="$DL/$REPO/releases/download/$tag"

home="${SUDO_USER:+$(getent passwd "$SUDO_USER" | cut -d: -f6)}"
home="${home:-$HOME}"
dest="$home/$name"

say "release $tag -> $dest"
if [[ "$dry" == 1 ]]; then
  echo "   [dry-run] download $base/$name and its .sha256, verify, save to $dest"
  [[ "$apply" == 1 ]] && echo "   [dry-run] then: $APPLY_BIN $dest"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fL --retry 3 --progress-bar -o "$tmp/$name" "$base/$name"
curl -fsSL --retry 3 -o "$tmp/$name.sha256" "$base/$name.sha256"
( cd "$tmp" && sha256sum -c "$name.sha256" ) || { echo "CHECKSUM_MISMATCH: refusing to use $name" >&2; exit 1; }
install -m 0644 "$tmp/$name" "$dest"
[[ -n "${SUDO_USER:-}" ]] && chown "$SUDO_USER": "$dest" || true
ls -lh "$dest"

# Keep this command up to date from the pack it just verified.
if [[ "$(id -u)" == 0 ]] && tar -xzf "$dest" -O deploy/fetch.sh >"$tmp/fetch.sh" 2>/dev/null && [[ -s "$tmp/fetch.sh" ]]; then
  install -m 0755 "$tmp/fetch.sh" "$SELF_COPY"
fi

if [[ "$apply" == 1 ]]; then
  [[ -x "$APPLY_BIN" ]] || { echo "MISSING_APPLY: install openrail-apply first (RUNBOOK, 'Updating later')" >&2; exit 1; }
  say "applying $dest"
  exec "$APPLY_BIN" "$dest"
fi
say "downloaded and verified. Put it live with: sudo openrail-apply $dest"
