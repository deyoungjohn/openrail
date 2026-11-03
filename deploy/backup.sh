#!/usr/bin/env bash
# Nightly SQLite backups. Run as root from openrail-backup.service.
set -euo pipefail

backup_dir="/var/backups/openrail"
install -d -m 0700 -o root -g root "$backup_dir"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
for db in /var/lib/openrail/api.sqlite /var/lib/openrail/indexer.sqlite; do
  [[ -f "$db" ]] || continue
  name="$(basename "$db" .sqlite)"
  target="$backup_dir/${name}-${timestamp}.sqlite"
  sqlite3 "$db" ".backup '$target'"
  chmod 0600 "$target"
  chown root:root "$target"
  echo "backed up $db -> $target"
done

find "$backup_dir" -type f -name '*.sqlite' -mtime +7 -delete
