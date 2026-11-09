#!/usr/bin/env bash
# Server: put a new pack live, or just restart. Run as root, on the server, any time you push new code.
#
#   sudo openrail-apply                 install the newest ~/openrail-server-*.tar.gz, restart, check, roll back on failure
#   sudo openrail-apply <pack.tar.gz>   install that pack
#   sudo openrail-apply --restart-only  no new code: reinstall service files, restart everything, check
#   sudo openrail-apply --rollback      go back to the previous release
#   add --dry-run to print what would happen without changing anything
#
# First time only (the script installs itself afterwards and updates itself on every run):
#   pack=$(ls -t ~/openrail-server-*.tar.gz | head -1); tar -xzf "$pack" -O deploy/apply.sh | sudo tee /usr/local/bin/openrail-apply >/dev/null
#   sudo chmod +x /usr/local/bin/openrail-apply
#
# If ~/openrail.env exists (uploaded with deploy/upload.sh --env or --env-only), the per-service env files are
# rewritten from it and the upload is shredded. Nothing else reads or prints a secret.
set -euo pipefail

ROOT="${OPENRAIL_ROOT:-/opt/openrail}"
ETC="${OPENRAIL_ETC:-/etc/openrail}"
UNIT_DIR="${OPENRAIL_UNIT_DIR:-/etc/systemd/system}"
CADDYFILE="${OPENRAIL_CADDYFILE:-/etc/caddy/Caddyfile}"
SELF_COPY="${OPENRAIL_SELF_COPY:-/usr/local/bin/openrail-apply}"
HEALTH_WAIT_SECONDS="${OPENRAIL_HEALTH_WAIT:-150}"
KEEP_RELEASES=1 # only the live release stays unpacked (about 1.2 GB); the previous one is reinstalled from its pack
KEEP_PACKS=2    # the packs of the live and the previous release (about 260 MB each)
CORE_SERVICES=(indexer issuer watcher api web) # start order: the api needs the indexer and issuer
TEST_MODE="${OPENRAIL_TEST:-0}"           # tests run in a temp folder: no systemd, no chown

dry=0
mode=pack
pack_arg=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --restart-only) mode=restart ;;
    --rollback) mode=rollback ;;
    -h | --help) sed -n 2,16p "$0"; exit 0 ;;
    *) pack_arg="$arg" ;;
  esac
done

say() { printf '== %s\n' "$*"; }
run() { # run a command, or only print it in a dry run
  if [[ "$dry" == 1 ]]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi
}
sysctl_run() { [[ "$TEST_MODE" == 1 ]] || run systemctl "$@"; }
chown_run() { [[ "$TEST_MODE" == 1 ]] || run chown "$@"; }

if [[ "$(id -u)" != 0 && "$TEST_MODE" != 1 ]]; then
  echo "NEED_ROOT: run with sudo" >&2
  exit 1
fi

current_target() { # the real folder behind the current link, or nothing
  if [[ -L "$ROOT/current" ]]; then readlink -f "$ROOT/current"; fi
}

install_unit_files() { # install_unit_files <release dir>: copy changed service files and the web server config
  local rel="$1" changed=0 f dest
  for f in "$rel"/deploy/systemd/*.service "$rel"/deploy/systemd/*.timer; do
    [[ -f "$f" ]] || continue
    dest="$UNIT_DIR/$(basename "$f")"
    if ! cmp -s "$f" "$dest"; then
      run install -m 0644 "$f" "$dest"
      changed=1
    fi
  done
  # Hand-made overrides from the first server setup; the unit files now carry the same settings.
  for svc in "${CORE_SERVICES[@]}"; do
    for stale in exec.conf corepack.conf; do
      if [[ -f "$UNIT_DIR/openrail-$svc.service.d/$stale" ]]; then
        run rm -f "$UNIT_DIR/openrail-$svc.service.d/$stale"
        changed=1
      fi
    done
  done
  if [[ "$changed" == 1 ]]; then sysctl_run daemon-reload; fi
  if [[ -f "$rel/deploy/Caddyfile" ]] && ! cmp -s "$rel/deploy/Caddyfile" "$CADDYFILE"; then
    if [[ "$TEST_MODE" == 1 || "$dry" == 1 ]] || caddy validate --config "$rel/deploy/Caddyfile" >/dev/null 2>&1; then
      run install -m 0644 "$rel/deploy/Caddyfile" "$CADDYFILE"
      sysctl_run reload caddy
    else
      echo "WARN: the new Caddyfile did not validate; the old one stays" >&2
    fi
  fi
}

service_units() { # service_units <release dir>: core order first, then any extra module units in the pack
  local rel="$1" svc unit skip
  for svc in "${CORE_SERVICES[@]}"; do
    [[ -f "$rel/deploy/systemd/openrail-$svc.service" ]] && printf '%s\n' "openrail-$svc.service"
  done
  for unit in "$rel"/deploy/systemd/openrail-*.service; do
    [[ -f "$unit" ]] || continue
    unit="$(basename "$unit")"
    case "$unit" in
      openrail-backup.service) continue ;;
    esac
    skip=0
    for svc in "${CORE_SERVICES[@]}"; do
      [[ "$unit" == "openrail-$svc.service" ]] && skip=1
    done
    ((skip == 0)) && printf '%s\n' "$unit"
  done
}

restart_all() { # restart_all <release dir>
  local rel="$1" unit
  mapfile -t units < <(service_units "$rel")
  say "restarting: ${units[*]}"
  for unit in "${units[@]}"; do
    # A unit whose environment file does not exist yet would crash-loop ("Failed to load environment files").
    # Say what is missing, leave the unit stopped and carry on with the others.
    local envline envpath
    envline="$(grep -m1 -E '^EnvironmentFile=[^-]' "$rel/deploy/systemd/$unit" 2>/dev/null || true)"
    envpath="${envline#EnvironmentFile=}"
    if [[ -n "$envpath" && ! -f "$ETC/$(basename "$envpath")" ]]; then
      say "SKIPPED $unit: $ETC/$(basename "$envpath") does not exist. Add its names to your openrail.env (see deploy/env/$(basename "$envpath").example), upload it with deploy/upload.sh --env, and apply again."
      sysctl_run disable --now "$unit" >/dev/null 2>&1 || true
      continue
    fi
    sysctl_run enable "$unit" >/dev/null 2>&1 || true # start at boot (harmless when already on)
    sysctl_run restart "$unit"
  done
}

healthy() { # healthy <release dir>: quiet health check
  if [[ "$TEST_MODE" == 1 ]]; then
    # tests: OPENRAIL_TEST_UNHEALTHY=<text> makes any release whose path contains it fail the check
    [[ -z "${OPENRAIL_TEST_UNHEALTHY:-}" || "$1" != *"$OPENRAIL_TEST_UNHEALTHY"* ]]
    return
  fi
  "$1/deploy/healthcheck.sh" >/dev/null 2>&1
}

wait_healthy() { # wait_healthy <release dir>: services take 20-60 s to come up
  local rel="$1" waited=0
  [[ "$dry" == 1 ]] && { say "would wait up to ${HEALTH_WAIT_SECONDS}s for the health check"; return 0; }
  say "waiting for the health check (up to ${HEALTH_WAIT_SECONDS}s)"
  while ((waited < HEALTH_WAIT_SECONDS)); do
    if healthy "$rel"; then return 0; fi
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

show_failures() {
  [[ "$TEST_MODE" == 1 ]] && { echo "---- (test mode: no logs)" >&2; return 0; }
  echo "---- health check output" >&2
  "$1/deploy/healthcheck.sh" 2>&1 | grep -E 'FAIL|failed' >&2 || true
  local unit
  while IFS= read -r unit; do
    if ! systemctl is-active --quiet "$unit" 2>/dev/null; then
      echo "---- last log lines of $unit (no keys are logged)" >&2
      journalctl -u "$unit" -n 15 --no-pager 2>&1 | cut -c1-220 >&2 || true
    fi
  done < <(service_units "$1")
}

switch_to() { # switch_to <release dir>: move the current link atomically
  local rel="$1"
  run ln -sfn "$rel" "$ROOT/current.new"
  run mv -T "$ROOT/current.new" "$ROOT/current"
}

prune_releases() { # after a healthy apply: only the live release stays unpacked
  local cur count=0 dir
  cur="$(current_target)"
  while IFS= read -r dir; do
    dir="${dir%/}"
    count=$((count + 1))
    if ((count > KEEP_RELEASES)) && [[ "$dir" != "$cur" ]]; then
      say "removing old release $(basename "$dir")"
      run rm -rf "$dir"
    fi
  done < <(ls -dt "$ROOT"/releases/*/ 2>/dev/null)
}

prune_packs() { # prune_packs <home>: each pack is ~250 MB; keep the packs of the live and the previous release
  local home="$1" count=0 pack
  while IFS= read -r pack; do
    count=$((count + 1))
    if ((count > KEEP_PACKS)); then
      say "removing old pack $(basename "$pack")"
      run rm -f "$pack"
    fi
  done < <(ls -t "$home"/openrail-server-*.tar.gz 2>/dev/null)
}

# ---------------------------------------------------------------------------------------------------------------
home_of_caller() {
  if [[ -n "${OPENRAIL_HOME:-}" ]]; then printf '%s\n' "$OPENRAIL_HOME"; return; fi # tests
  local user="${SUDO_USER:-$(id -un)}"
  getent passwd "$user" | cut -d: -f6
}

mkdir -p "$ROOT/releases"
old="$(current_target)"

case "$mode" in
  rollback)
    prev="$(cat "$ROOT/previous" 2>/dev/null || true)"
    [[ -n "$prev" ]] || { echo "NO_PREVIOUS_RELEASE" >&2; exit 1; }
    if [[ ! -d "$prev" ]]; then
      # Only the live release stays unpacked. Reinstall the previous one from its pack, or from GitHub.
      commit="$(basename "$prev")"
      commit="${commit%-*}"
      pack="$(home_of_caller)/openrail-server-$commit.tar.gz"
      if [[ -f "$pack" ]]; then
        say "the previous release is not unpacked any more; reinstalling it from $(basename "$pack")"
        if [[ "$dry" == 1 ]]; then
          exec "$0" "$pack" --dry-run
        else
          exec "$0" "$pack"
        fi
      fi
      echo "NO_PREVIOUS_RELEASE: its pack is gone too. Fetch it again: sudo openrail-fetch --apply $commit (GitHub keeps only the newest packs)" >&2
      exit 1
    fi
    say "rolling back to $(basename "$prev")"
    switch_to "$prev"
    printf '%s\n' "$old" >"$ROOT/previous"
    install_unit_files "$prev"
    restart_all "$prev"
    wait_healthy "$prev" || { show_failures "$prev"; echo "ROLLBACK_UNHEALTHY" >&2; exit 1; }
    say "rolled back; running $(basename "$prev")"
    exit 0
    ;;
  restart)
    [[ -n "$old" && -d "$old" ]] || { echo "NO_CURRENT_RELEASE" >&2; exit 1; }
    say "restart only, release $(basename "$old")"
    install_unit_files "$old"
    restart_all "$old"
    wait_healthy "$old" || { show_failures "$old"; echo "UNHEALTHY" >&2; exit 1; }
    say "healthy"
    exit 0
    ;;
esac

home="$(home_of_caller)"
if [[ -n "$pack_arg" ]]; then
  pack="$pack_arg"
else
  # shellcheck disable=SC2012
  pack="$(ls -t "$home"/openrail-server-*.tar.gz 2>/dev/null | head -1 || true)"
fi
[[ -n "$pack" && -f "$pack" ]] || { echo "NO_PACK: upload one first (deploy/upload.sh on the laptop)" >&2; exit 1; }
commit="$(basename "$pack" | sed -E 's/^openrail-server-(.*)\.tar\.gz$/\1/')"
[[ "$commit" =~ ^[0-9a-zA-Z._-]+$ ]] || { echo "BAD_PACK_NAME: $pack" >&2; exit 1; }
# The folder name carries a short hash of the pack itself: the same commit built again with another
# NEXT_PUBLIC value is a different release, and the same pack uploaded twice is the same one.
version="$commit-$(sha256sum "$pack" | cut -c1-8)"
new="$ROOT/releases/$version"

say "pack $(basename "$pack") -> release $version"
if [[ "$old" == "$new" ]]; then
  say "this release is already live; restarting it"
else
  if [[ -d "$new" ]]; then
    say "release folder exists from an earlier run; replacing it"
    run rm -rf "$new"
  fi
  run mkdir -p "$new"
  run tar -xzf "$pack" -C "$new"
  chown_run -R root:openrail "$new"
  run chmod -R g+rX "$new"
  [[ -d "$new/services/web/.next" ]] && chown_run -R openrail-web:openrail "$new/services/web/.next"
  run install -d -m 0770 -o "${OPENRAIL_REPORTS_OWNER:-openrail-watcher}" -g openrail "$new/reports" 2>/dev/null \
    || run install -d -m 0770 "$new/reports"
fi

# Env files: only when a new env upload is waiting.
envfile="$home/openrail.env"
if [[ -f "$envfile" ]]; then
  say "applying the uploaded env file"
  run chmod 600 "$envfile"
  run "$new/deploy/split-env.sh" "$envfile" "$ETC"
  run shred -u "$envfile"
fi

[[ -n "$old" && "$old" != "$new" ]] && printf '%s\n' "$old" >"$ROOT/previous"
say "switching to $version"
switch_to "$new"

# Keep this script itself current.
if [[ -f "$new/deploy/apply.sh" ]] && ! cmp -s "$new/deploy/apply.sh" "$SELF_COPY"; then
  run install -m 0755 "$new/deploy/apply.sh" "$SELF_COPY"
fi

install_unit_files "$new"
restart_all "$new"
if wait_healthy "$new"; then
  say "healthy; running release $version (previous: $(basename "${old:-none}"))"
  prune_releases
  prune_packs "$home"
  exit 0
fi

show_failures "$new"
if [[ -n "$old" && -d "$old" && "$old" != "$new" ]]; then
  echo "== UNHEALTHY: rolling back to $(basename "$old")" >&2
  switch_to "$old"
  install_unit_files "$old"
  restart_all "$old"
  if wait_healthy "$old"; then
    echo "== rolled back to $(basename "$old"); release $version is NOT live" >&2
  else
    echo "== ROLLBACK ALSO UNHEALTHY: look at the log lines above" >&2
  fi
else
  echo "== UNHEALTHY and there is no previous release to go back to" >&2
fi
exit 1
