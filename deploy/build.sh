#!/usr/bin/env bash
# Build the server pack on a developer machine. Never run this on the EC2 host.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v pnpm >/dev/null 2>&1 || {
  echo "MISSING_TOOL: pnpm" >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "MISSING_TOOL: node" >&2
  exit 1
}

node_version="$(node -p 'process.versions.node')"
case "$node_version" in
  22.23.*) ;;
  *)
    echo "NODE_VERSION: expected 22.23.x, got $node_version" >&2
    exit 1
    ;;
esac

export NEXT_PUBLIC_API_MODE="${NEXT_PUBLIC_API_MODE:-live}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-https://api.openrail.incepture.dev}"
export NEXT_PUBLIC_NEAR_NETWORK="${NEXT_PUBLIC_NEAR_NETWORK:-mainnet}"
export NEXT_PUBLIC_ROOT_CONTRACT="${NEXT_PUBLIC_ROOT_CONTRACT:-openrail.near}"

pnpm install --frozen-lockfile
pnpm --filter @openrail/web build

version="$(git rev-parse --short HEAD)"
archive="dist/openrail-server-${version}.tar.gz"
mkdir -p dist

tar \
  --exclude='./.git' \
  --exclude='./target' \
  --exclude='./dist' \
  --exclude='./services/web/.next/cache' \
  --exclude='./node_modules/.cache' \
  -czf "$archive" \
  package.json \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  openrail.modules.json \
  config \
  deploy \
  packages \
  services \
  node_modules

sha256sum "$archive"
ls -lh "$archive"
echo "server pack ready: $archive (extract, do not build, on the server)"
