#!/usr/bin/env bash
# Secret scanner. Fails on likely secrets; prints only "<rule>: <file>:<line>", never the value.
#   scripts/secret-scan.sh [DIR]     scan DIR (default: repo root)
#   scripts/secret-scan.sh --self-test
set -euo pipefail

scan() {
  local root="$1" hits=0 out
  local -a files=()
  while IFS= read -r -d '' f; do files+=("$f"); done < <(
    find "$root" \( -name .git -o -name node_modules -o -name target -o -name spikes -o -name dist -o -name .next \) -prune \
      -o -type f ! -name 'pnpm-lock.yaml' ! -name 'Cargo.lock' ! -name 'secret-scan.sh' -print0
  )
  [ "${#files[@]}" -gt 0 ] || return 0

  # rule-name|flags|regex
  local rules=(
    'near-ed25519-secret-key|-E|ed25519:[1-9A-HJ-NP-Za-km-z]{80,}'
    'jwt|-E|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'
    'hex64-near-secret-word|-Ei|(key|secret|token|private|seed|password)[^0-9a-fA-F]{0,30}[0-9a-fA-F]{64}([^0-9a-fA-F@]|$)'
    'seed-phrase-keyword|-Ei|(seed|mnemonic|recovery|passphrase)( phrase)?[^a-z]{0,20}([a-z]{3,8}[ ,]+){11,23}[a-z]{3,8}'
    'seed-phrase-line|-E|^[[:space:]"'"'"'`]*([a-z]{3,8} ){11}([a-z]{3,8} ){0,12}[a-z]{3,8}[[:space:]"'"'"'`,;]*$'
  )
  local r name flags re
  for r in "${rules[@]}"; do
    IFS='|' read -r name flags re <<<"$r"
    # shellcheck disable=SC2086
    out=$(grep $flags -InH -e "$re" "${files[@]}" 2>/dev/null || true)
    # Transaction signatures are also "ed25519:" + 88 base58 chars; they are public.
    if [ "$name" = near-ed25519-secret-key ]; then out=$(printf '%s\n' "$out" | grep -viE 'signature' || true); fi
    out=$(printf '%s\n' "$out" | cut -d: -f1,2 | sed '/^$/d')
    if [ -n "$out" ]; then
      while IFS= read -r l; do echo "SECRET-SCAN FAIL [$name]: $l"; done <<<"$out"
      hits=1
    fi
  done
  return $hits
}

self_test() {
  local d rc
  d=$(mktemp -d)
  trap 'rm -rf "$d"' RETURN
  # Fake values are assembled at run time so this file never contains a match.
  local b58 hex jwt words
  b58=$(printf '1%.0s' $(seq 1 88))
  hex=$(printf 'a1%.0s' $(seq 1 32))
  jwt="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlc2ln"
  words="alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima"

  scan "$d" >/dev/null || { echo "self-test FAIL: clean dir flagged"; return 1; }
  printf 'clean text\nNEAR_ROOT_ACCOUNT=\n' >"$d/ok.txt"
  scan "$d" >/dev/null || { echo "self-test FAIL: clean file flagged"; return 1; }

  local n=0 case_
  for case_ in "k=ed25519:$b58" "t=$jwt" "api_key = \"$hex\"" "seed phrase: $words" "$words"; do
    n=$((n + 1))
    printf '%s\n' "$case_" >"$d/bad$n.txt"
    if scan "$d" >"$d.out" 2>&1; then echo "self-test FAIL: case $n not detected"; rm -f "$d.out"; return 1; fi
    if grep -q -e "$b58" -e "$hex" -e "$jwt" -e "$words" "$d.out"; then echo "self-test FAIL: scanner printed a value"; rm -f "$d.out"; return 1; fi
    rm -f "$d/bad$n.txt" "$d.out"
  done
  rc=0; scan "$d" >/dev/null || rc=1
  [ "$rc" = 0 ] || { echo "self-test FAIL: not clean after cleanup"; return 1; }
  echo "secret-scan self-test: OK (5 patterns detected, nothing printed, clean dir passes)"
}

case "${1:-}" in
  --self-test) self_test ;;
  *)
    cd "$(dirname "$0")/.."
    root="${1:-.}"
    self_test >/dev/null
    if scan "$root"; then echo "secret-scan: OK"; else echo "secret-scan: FAILED (values not shown)"; exit 1; fi
    ;;
esac
