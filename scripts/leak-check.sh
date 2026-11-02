#!/usr/bin/env bash
# Owner: P0.2. Delegates to scripts/leak-check.ts.
set -euo pipefail
cd "$(dirname "$0")/.."
exec pnpm exec tsx scripts/leak-check.ts
