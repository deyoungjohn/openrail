#!/usr/bin/env bash
# One file in, one file per service out. A service file already on the server is MERGED, never replaced (see merge_env).
#
#   sudo deploy/split-env.sh /path/to/openrail.env            # writes /etc/openrail/<service>.env
#   deploy/split-env.sh /path/to/openrail.env /tmp/check      # dry look, writes to another folder
#
# You keep one KEY=VALUE file. Each service still gets only the names listed in its own
# deploy/env/<service>.env.example, so the internet-facing API process never holds the issuer
# or watcher private keys. Names that no service uses are reported and dropped.
set -euo pipefail
cd "$(dirname "$0")/.."

src="${1:?usage: split-env.sh <openrail.env> [out_dir]}"
out="${2:-/etc/openrail}"
services=(api issuer watcher indexer web)
# Include module/service templates added by a private build without naming them in core code.
for template in deploy/env/*.env.example; do
  svc="$(basename "$template" .env.example)"
  [[ "$svc" == "openrail" ]] && continue
  skip=0
  for existing in "${services[@]}"; do
    [[ "$existing" == "$svc" ]] && skip=1
  done
  ((skip == 0)) && services+=("$svc")
done

[[ -f "$src" ]] || { echo "NOT_FOUND: $src" >&2; exit 1; }
perm="$(stat -c %a "$src")"
[[ "$perm" == "600" || "$perm" == "400" ]] || { echo "BAD_MODE: $src is $perm, run: chmod 600 $src" >&2; exit 1; }
case "$(readlink -f "$src")" in
  "$(pwd)"/*) echo "INSIDE_REPO: keep the combined file outside the repository" >&2; exit 1 ;;
esac

bad="$(grep -vE '^\s*(#.*)?$|^[A-Z][A-Z0-9_]*=' "$src" | head -1 || true)"
[[ -z "$bad" ]] || { echo "BAD_LINE: lines must be NAME=value (a line starts with: ${bad:0:12}...)" >&2; exit 1; }

value_of() { grep -m1 -E "^$1=" "$src" | cut -d= -f2- || true; }
names_of() {
  local list
  list="$(grep -E '^[A-Z][A-Z0-9_]*=' "deploy/env/$1.env.example" | cut -d= -f1)"
  printf '%s\n' "$list"
  # Every service that reads NEAR_RPC_URL also gets all the fallbacks (NEAR_RPC_URL_FALLBACK, _2, _3 ...),
  # so you set them once in the combined file.
  if grep -qx 'NEAR_RPC_URL' <<<"$list"; then
    grep -oE '^NEAR_RPC_URL_FALLBACK[_0-9]*' "$src" | sort -u | grep -vxF -f <(printf '%s\n' "$list") || true
  fi
}

# Merge the newly generated file into the one already on the server. Nothing the server has is dropped: a name only
# the server file has stays; a name only the new file has is appended; a name in both with the same value is left;
# a name in both with a DIFFERENT value is asked about (keep the server's or take the new one). The question shows
# no secret: a URL is shown as its host, anything else as its length. Answers: k keep, o overwrite, K keep all the
# rest, O overwrite all the rest. Where it asks: the terminal (/dev/tty), or the file named by OPENRAIL_ENV_ANSWERS
# (one answer per line, for tests). With neither, OPENRAIL_ENV_CONFLICT=keep|overwrite decides (default keep).
merge_env() {
  python3 -I - "$1" "$2" "$3" "$4" <<'PY'
import os, re, sys

new_path, old_path, out_path, svc = sys.argv[1:5]
NAME = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")

def read(path):
    lines = open(path, encoding="utf-8").read().splitlines()
    values = {}
    for line in lines:
        m = NAME.match(line)
        if m:
            values[m.group(1)] = m.group(2)
    return lines, values

old_lines, old = read(old_path)
_, new = read(new_path)

def mask(value):
    m = re.match(r"^(https?://[^/?#]+)", value)
    return (m.group(1) + "/...") if m else f"{len(value)} characters"

answers = None
source = os.environ.get("OPENRAIL_ENV_ANSWERS")
try:
    answers = open(source if source else "/dev/tty", encoding="utf-8")
except OSError:
    answers = None
policy = os.environ.get("OPENRAIL_ENV_CONFLICT", "keep")
standing = None  # "k" or "o" once the person said "all the rest"

added, overwrote, kept, same = [], [], [], 0
result = list(old_lines)
index = {}
for i, line in enumerate(result):
    m = NAME.match(line)
    if m:
        index[m.group(1)] = i

for name, value in new.items():
    if name not in old:
        result.append(f"{name}={value}")
        added.append(name)
        continue
    if old[name] == value:
        same += 1
        continue
    choice = standing
    if choice is None:
        if answers is None:
            choice = "o" if policy == "overwrite" else "k"
        else:
            while choice is None:
                sys.stderr.write(
                    f"{svc}.env: {name} differs. On the server: {mask(old[name])}. In the new file: {mask(value)}.\n"
                    "  [k] keep the server's   [o] overwrite   [K] keep all the rest   [O] overwrite all the rest > "
                )
                sys.stderr.flush()
                reply = answers.readline()
                if reply == "":
                    choice = "k"
                    break
                reply = reply.strip()
                if reply in ("k", "o"):
                    choice = reply
                elif reply in ("K", "O"):
                    standing = reply.lower()
                    choice = standing
    if choice == "o":
        result[index[name]] = f"{name}={value}"
        overwrote.append(name)
    else:
        kept.append(name)

only_server = [n for n in old if n not in new]
open(out_path, "w", encoding="utf-8").write("\n".join(result) + "\n")
parts = [f"{len(added)} added" + (f" ({', '.join(added)})" if added else "")]
parts.append(f"{same} same")
if overwrote:
    parts.append(f"{len(overwrote)} overwritten ({', '.join(overwrote)})")
if kept:
    parts.append(f"{len(kept)} differ, server value kept ({', '.join(kept)})")
if only_server:
    parts.append(f"{len(only_server)} only on the server, untouched")
print(f"{svc}.env merged: " + "; ".join(parts))
PY
}

mkdir -p "$out"
declare -A used=()
for svc in "${services[@]}"; do
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  printf '# %s process environment. Generated by deploy/split-env.sh; edit the combined file and run it again.\n' "$svc" > "$tmp"
  missing=()
  while read -r name; do
    used[$name]=1
    if grep -qE "^$name=" "$src"; then
      printf '%s=%s\n' "$name" "$(value_of "$name")" >> "$tmp"
    else
      missing+=("$name")
    fi
  done < <(names_of "$svc")
  if [[ -f "$out/$svc.env" ]]; then
    # A file already on the server may hold settings added by hand: merge, never replace.
    merged="$(mktemp)"
    summary="$(merge_env "$tmp" "$out/$svc.env" "$merged" "$svc")" || { rm -f "$tmp" "$merged"; exit 1; }
    mv "$merged" "$tmp"
    echo "$summary"
  fi
  # Keep the file as it was, so a merge can always be undone: cp /etc/openrail/<svc>.env.bak.<time> back.
  [[ -f "$out/$svc.env" ]] && cp -p "$out/$svc.env" "$out/$svc.env.bak.$(date +%Y%m%d-%H%M%S)"
  if [[ "$(id -u)" == 0 ]]; then
    install -m 0600 -o root -g root "$tmp" "$out/$svc.env"
  else
    install -m 0600 "$tmp" "$out/$svc.env"
  fi
  rm -f "$tmp"
  count="$(grep -cE "^[A-Z]" "$out/$svc.env" || true)"
  # "Not set" is about the file now on the server (a name the server file already had is set), not about the combined file.
  unset_now=()
  for name in "${missing[@]}"; do
    grep -qE "^$name=.+" "$out/$svc.env" || unset_now+=("$name")
  done
  echo "$svc.env: $count names${unset_now:+, not set anywhere (defaults apply): ${unset_now[*]}}"
  if ((${#missing[@]} > ${#unset_now[@]})); then
    echo "  kept from the server's file (not in the combined file): $((${#missing[@]} - ${#unset_now[@]})) name(s)"
  fi
done

laptop_only=" SERVER_IP SSH_KEY_FILE RELAYER_ACCOUNT_ID WATCHER_PUBLIC_KEY ISSUER_PUBLIC_KEY RELAYER_PUBLIC_KEY "
while read -r name; do
  [[ "$laptop_only" == *" $name "* ]] && continue
  [[ -n "${used[$name]:-}" ]] || echo "UNUSED: $name is in the combined file but no service reads it (dropped)"
done < <(grep -oE '^[A-Z][A-Z0-9_]*' "$src" | sort -u)
