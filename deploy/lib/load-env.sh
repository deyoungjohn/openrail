# Source this file, then call:  load_openrail_env [NAME_PATTERN ...]
#
# Reads the laptop env file (default ~/.openrail/openrail.env, override with OPENRAIL_ENV) and exports ONLY the
# names that match the given shell patterns (for example 'NEXT_PUBLIC_*' 'SERVER_IP'). With no pattern it exports
# nothing, so a script never receives more of the file than it asked for (a build must not see private keys).
# Names already set and non-empty in the environment win over the file. The file is parsed, never executed.
load_openrail_env() {
  local file="${OPENRAIL_ENV:-$HOME/.openrail/openrail.env}"
  if [[ ! -f "$file" ]]; then
    echo "NO_ENV_FILE: $file (create it with deploy/init-env.sh)" >&2
    return 1
  fi
  local mode
  mode="$(stat -c %a "$file")"
  if [[ "$mode" != "600" && "$mode" != "400" ]]; then
    echo "BAD_MODE: $file is $mode, run: chmod 600 $file" >&2
    return 1
  fi
  if [[ "$(stat -c %u "$file")" != "$(id -u)" ]]; then
    echo "NOT_OWNER: $file must belong to you" >&2
    return 1
  fi
  local line name value pattern
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      echo "BAD_LINE in $file: lines must be NAME=value or comments" >&2
      return 1
    fi
    name="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    for pattern in "$@"; do
      # shellcheck disable=SC2053
      if [[ "$name" == $pattern ]]; then
        [[ -n "${!name:-}" ]] || export "$name=$value"
        break
      fi
    done
  done <"$file"
}
