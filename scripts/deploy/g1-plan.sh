#!/usr/bin/env bash
# Print the human-run G1 mainnet plan. This script never signs, sends, or reads a secret.
# It does not set OWED_CONFIRM_MAINNET or any other send flag.
set -euo pipefail
cd "$(dirname "$0")/../.."

api="${API_BASE_URL:-https://api.openrail.incepture.dev}"
web="${WEB_BASE_URL:-https://openrail.incepture.dev}"
root="${NEAR_ROOT_ACCOUNT:-openrail.near}"
network="${NEAR_ENV:-mainnet}"
open_cmd="${OPEN_CMD:-xdg-open}"

if [[ "$network" != "mainnet" ]]; then
  echo "NEAR_ENV must be mainnet for the G1 run" >&2
  exit 1
fi

cat <<EOF
# Openrail G1 mainnet run (dry plan)
# Read-only: this script did not sign or send anything.
# Root: $root
# API:  $api
# Web:  $web
#
# Run every command below yourself from the repository root. Keep every transaction hash
# in reports/G1.json. Never paste a secret into a shell history you share.

## 0. Deploy first
\$ scripts/deploy/plan.sh
# Review and run the printed deploy, set_config, and add-key commands. Then:
\$ near contract call-function as-read-only $root config json-args '{}' network-config $network now
\$ near contract call-function as-read-only $root contract_source_metadata json-args '{}' network-config $network now

## 1. Issue \$3 through the issuer path
\$ curl -sS -X POST '$api/v1/invoices' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -H 'Idempotency-Key: g1-issue-$(date -u +%Y%m%dT%H%M%SZ)' \\
  -H 'content-type: application/json' \\
  -d '{
    "invoice_number": "G1-001",
    "issuer_legal_name": "Openrail",
    "debtor_legal_name": "G1 debtor",
    "debtor_type": "evm",
    "debtor_key": "<EVM_ADDRESS>",
    "amount_usd": "3.00",
    "due_date": "$(date -u -d '+7 days' +%Y-%m-%d)",
    "line_items": [
      { "description": "G1 core run", "quantity": 1, "unit_amount_usd": "3.00" }
    ]
  }'
# Expected: 201 with the token id and pay link. Record token_id, id, and every tx hash.

## 2. Acknowledge with the real EVM wallet
\$ curl -sS '$api/v1/ack/<TOKEN_ID>'
# Sign the returned EIP-712 message in the wallet, then:
\$ curl -sS -X POST '$api/v1/ack/<TOKEN_ID>/evm' \\
  -H 'content-type: application/json' \\
  -H 'Idempotency-Key: g1-ack-$(date -u +%Y%m%dT%H%M%SZ)' \\
  -d '{"chain_id": 8453, "signature": "<0x_EIP712_SIGNATURE>"}'
# Record the acknowledge_evm transaction hash.

## 3. Pay \$1 USDC on Base and \$1 in ETH on Arbitrum
\$ $open_cmd '$web/pay/<TOKEN_ID>'
# Pay 1.00 USDC on Base, then 1.00 in ETH on Arbitrum from the wallet.
# Poll the claim and receipts after each payment:
\$ curl -sS '$api/v1/pay/claims/<TOKEN_ID>'
\$ curl -sS '$api/v1/invoices/<INVOICE_ID>/receipts'
# Expected: each payment is booked in base units and each receipt renders from its booked event.

## 4. Sell to a second account
\$ near contract call-function as-transaction $root nft_transfer \\
  json-args '{"receiver_id":"<BUYER_ACCOUNT>","token_id":"<TOKEN_ID>","approval_id":null,"memo":"<64_HEX_ASSIGNMENT_DOC>"}' \\
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' \\
  sign-as '<SELLER_ACCOUNT>' network-config $network sign-with-keychain send
\$ near contract call-function as-read-only $root claim json-args '{"token_id":"<TOKEN_ID>"}' network-config $network now
# Expected: owner_id is the buyer; the sale memo is stored as assignment_doc_hash.

## 5. Pay \$1 SOL after the sale
\$ $open_cmd '$web/pay/<TOKEN_ID>'
# Pay 1.00 in SOL. The buyer receives the payment; the seller receives nothing.
\$ curl -sS '$api/v1/invoices/<INVOICE_ID>/receipts'
# Expected: the new receipt is paid to the buyer (the current owner at the cut-off).

## 6. Transfer during reconcile
\$ near contract call-function as-transaction $root reconcile \\
  json-args '{"token_id":"<TOKEN_ID>"}' prepaid-gas '250 Tgas' attached-deposit '0 NEAR' \\
  sign-as '<WATCHER_ACCOUNT>' network-config $network sign-with-keychain send
\$ near contract call-function as-transaction $root nft_transfer \\
  json-args '{"receiver_id":"<THIRD_ACCOUNT>","token_id":"<TOKEN_ID>","approval_id":null,"memo":"<64_HEX_ASSIGNMENT_DOC>"}' \\
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' \\
  sign-as '<BUYER_ACCOUNT>' network-config $network sign-with-keychain send
# Expected while Reconciling is active: refusal with "Rule 1"; record the failed transaction hash.

## 7. Cash out \$1 to Polygon
\$ curl -sS -X POST '$api/v1/cashout/quote' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -H 'Idempotency-Key: g1-cashout-$(date -u +%Y%m%dT%H%M%SZ)' \\
  -H 'content-type: application/json' \\
  -d '{"amount":"1000000","destination_chain":"polygon","address":"<POLYGON_ADDRESS>"}'
# Follow the returned deposit instruction in the UI (open the invoice and choose cash out).
# Poll the payment:
\$ curl -sS '$api/v1/payments/<PAYMENT_ID>'
# Expected: the quote is written before the address is shown, and the payment reaches Polygon.

## 8. Report
# Fill reports/G1.json with every hash from steps 1-7 and the PASS/FAIL result.
# The report must include: issue, ack, two EVM payments, sale, SOL payment, refused transfer,
# cash-out, plus the deployed code hash from step 0.
EOF
