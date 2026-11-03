# CLI

`openrail` is the command-line client for the REST API. It is built on
`@openrail/api-client` and never signs a transaction.

## Try it against the mock

```bash
# terminal 1
MOCK=1 pnpm --filter @openrail/api start

# terminal 2
export OPENRAIL_API_URL=http://127.0.0.1:8787
export OPENRAIL_API_KEY=or_sk_live_example_not_a_real_key

pnpm --filter @openrail/cli start -- routes --json
```

→ see `{"data":[...]}` with the 13 allow-listed routes from `fixtures/api/routes.list.json`.

```bash
pnpm --filter @openrail/cli start -- invoices list --json
```

→ see the `invoices.list.json` fixture.

## Create an invoice

```bash
pnpm --filter @openrail/cli start -- invoices create --json \
  --data '{"invoice_number":"INV-2026-001","issuer_legal_name":"Acme Ltd","debtor_legal_name":"Debtor Co","debtor_key":"debtor.openrail.near","amount_usd":"12.50","due_date":"2026-12-01","line_items":[{"description":"Design","quantity":1,"unit_amount_usd":"12.50"}]}'
```

→ see the created invoice (`token_id`, `claim_account`, `terms_hash`, `pay_link`).
→ add `--dry-run` to preview `{"dry_run":true,"request":{"method":"POST","path":"/v1/invoices",...}}` instead.

Creates and sends execute by default: `invoices create`, `invoices send`,
`webhooks create`, `webhooks test`, `keys create`. Add `--dry-run` to preview any
write. Destructive commands (`keys rotate`, `keys revoke`) refuse without `--yes`.
Reads never need a flag.

## Read commands

| Command                                                            | JSON result                                                            |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `invoices get <id> --json`                                         | `InvoiceDetail` (`invoice` + live `claim`, including `kind_rules`).    |
| `invoices list [--status] [--limit] [--cursor] --json`             | `{data: Invoice[], next_cursor}`.                                      |
| `payments get <id> --json`                                         | `Payment` (`swap_details` holds provider fields).                      |
| `receipts list <invoice-id> --json`                                | `{data: Receipt[]}`.                                                   |
| `routes --json`                                                    | `{data: Route[]}`.                                                     |
| `webhooks list --json`                                             | `{data: WebhookEndpoint[]}` (no secrets).                              |
| `webhooks deliveries <id> --json`                                  | `{data: WebhookDelivery[]}`.                                           |
| `keys list --json`                                                 | `{data: ApiKey[]}` (prefix only, no secret).                           |
| `statements --from 2026-11-01 --to 2026-11-30 --format csv --json` | base64 statement envelope.                                             |
| `auth session --json`                                              | `{account_id, expires_at}`; 401 if the key is not an `or_sess_` token. |
| `whoami --json`                                                    | `Business` profile for the API key.                                    |

## Write commands

| Command                                                               | Notes                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `invoices create ...`                                                 | executes; add `--dry-run` to preview.                      |
| `invoices send <id> --to you@example.com`                             | emails the pay link; `--dry-run` previews.                 |
| `webhooks create --url URL --events invoice.paid,invoice.closed`      | returns the signing secret once.                           |
| `webhooks test <id>`                                                  | sends a signed test event.                                 |
| `keys create --name Production --scopes invoices:read,invoices:write` | returns the key secret once.                               |
| `keys rotate <id> --yes` / `keys revoke <id> --yes`                   | old key stops working; without `--yes` prints the request. |

`--idempotency-key KEY` is forwarded on every write.

## Cash out: the CLI prints the transaction, never signs it

```bash
export NEAR_ACCOUNT_ID=acme.openrail.near
pnpm --filter @openrail/cli start -- cashout quote --json \
  --amount 2000000 --destination-chain base --address 0x1111111111111111111111111111111111111111
```

→ the result includes `near_cli` with the exact `near call intents.near mt_transfer ...`
command. Run it with your own NEAR wallet:

```bash
near call intents.near mt_transfer '{"receiver_id":"...","token_id":"...","amount":"2000000","msg":null}' --accountId acme.openrail.near
```

The CLI never holds or reads a NEAR private key.

## Env, output and exit codes

- `OPENRAIL_API_URL` — required; `--api-url` overrides it.
- `OPENRAIL_API_KEY` — required; a secret key, publishable key or `or_sess_` session token.
  It is never printed. Missing values print `MISSING_ENV: <NAME>`.
- `auth session` needs an `or_sess_` token; a secret API key correctly gets 401. Use
  `whoami` for an API key's business profile.
- `NEAR_ACCOUNT_ID` — optional; used only in the printed cash-out command.
- `--json` on every command: success is JSON on stdout, errors are
  `{"error":{"code","message","details?"}}` on stderr.
- Without `--json`, list results render as tables and single results as `key: value` lines.
- Exit codes: `0` success, `1` API/HTTP error (`API_ERROR`), `2` usage or missing env
  (`INVALID_ARGS`, `MISSING_ENV`).

The mock API is the same fixture server the UI uses; see `fixtures/api/README.md`.
