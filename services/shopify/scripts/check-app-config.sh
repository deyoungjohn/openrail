#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOML_FILE="${1:-"${SCRIPT_DIR}/../shopify.app.toml"}"

if [ ! -f "${TOML_FILE}" ]; then
  echo "ERROR: shopify.app.toml not found at: ${TOML_FILE}" >&2
  exit 1
fi

CLIENT_ID_LINE="$(grep -E '^[[:space:]]*client_id[[:space:]]*=' "${TOML_FILE}" || true)"

if [ -z "${CLIENT_ID_LINE}" ]; then
  echo "ERROR: client_id is missing in ${TOML_FILE}" >&2
  exit 1
fi

CLIENT_ID="$(echo "${CLIENT_ID_LINE}" | sed -E 's/^[[:space:]]*client_id[[:space:]]*=[[:space:]]*["'\'']?([^"'\'']*)["'\'']?.*$/\1/')"

if [ -z "${CLIENT_ID}" ]; then
  echo "ERROR: client_id is empty in ${TOML_FILE}" >&2
  echo "Shopify CLI requires a real Client ID in shopify.app.toml before running 'shopify app deploy'." >&2
  echo "Copy Client ID from Dev Dashboard -> Apps -> Openrail Payments -> Settings -> Client ID." >&2
  exit 1
fi

if [[ "${CLIENT_ID}" =~ \$\{.*\} ]] || [[ "${CLIENT_ID}" =~ \<.*?\> ]] || [[ "${CLIENT_ID}" =~ ^YOUR_ ]] || [[ "${CLIENT_ID}" == *"CLIENT_ID"* ]]; then
  echo "ERROR: client_id in ${TOML_FILE} still contains placeholder: '${CLIENT_ID}'" >&2
  echo "The Shopify CLI does NOT expand environment variables in shopify.app.toml." >&2
  echo "Please paste your real Shopify Client ID into shopify.app.toml before running 'shopify app deploy'." >&2
  echo "Found in: Shopify Dev Dashboard -> Apps -> Openrail Payments -> Settings -> Client ID." >&2
  exit 1
fi

echo "OK: client_id is configured (${CLIENT_ID})"
exit 0
