# Openrail

Openrail is how a business gets paid in stablecoins. An invoice link lets the
client pay in the asset they hold on an allow-listed chain; the payment is
matched to that invoice and paid out to the business. Every invoice gets its own
keyless NEAR account controlled by an NEP-171 token.

Designed and tested before 1 Nov; see `evidence/`.

Status tags used in these docs: **built** (code and tests in this repository),
**tested** (exercised against the sandbox or mainnet as stated), **exploring**
(not part of the shipped path).

## Try it in 2 minutes

- Hosted app: business sign-in, create an invoice, open its pay and
  acknowledgement pages. **built**
- CLI: `pnpm --filter @openrail/cli start -- routes --json`. **built**
- Mock API for UI work: `MOCK=1 pnpm --filter @openrail/api start`. **built**

## Do X → see Y

1. `cp .env.example .env` → see the variable names only; values are never
   committed. **built**
2. `make test` → see the Rust sandbox, model and service suites pass, with the
   count printed. **tested**
3. Create a claim with your own EVM address as the debtor → see its
   `c-<n>.<root>` account on an explorer with no access keys, and the claim token
   in the business's NEAR wallet. **tested** (K1; see
   [`evidence/K1-2026-10-28T17-22-19Z.json`](../../../evidence/K1-2026-10-28T17-22-19Z.json)).
4. Open the acknowledgement link and sign with that wallet → see every term on
   the page, then the `ack` event with your address. **tested** (K14; see
   [`evidence/K14-T2-2026-10-29T16-08-09Z.json`](../../../evidence/K14-T2-2026-10-29T16-08-09Z.json)).
5. Open the pay link, choose a chain and asset, and pay → see the locked amount,
   the claim's public `intents.near` balance rise by the amount due, then
   `booked` and `distributed`. The receipt shows the origin transaction and the
   shield/unshield hashes. **tested**; booking latency is recorded in
   [`evidence/K12-partB-amended-2026-10-29T12-13-42Z.json`](../../../evidence/K12-partB-amended-2026-10-29T12-13-42Z.json).
6. Transfer the claim token to a second account → pay from another chain on the
   same link → see `distributed` go to the new holder and nothing to the seller.
   **tested** (K13; see
   [`evidence/K13-T2-2026-10-29T18-34-40Z.json`](../../../evidence/K13-T2-2026-10-29T18-34-40Z.json)).
7. Try to transfer while a reconcile is running → see the refusal with the rule
   number in plain words. **built**; the rule tests are in the contract suite.
8. Cash out to another chain → see the route cost first, then the arrival.
   **tested** (K11; see
   [`evidence/pay-report-2026-10-31T19-13-15-901Z.json`](../../../evidence/pay-report-2026-10-31T19-13-15-901Z.json)).
9. Read [`TRUST.md`](TRUST.md), [`COSTS.md`](COSTS.md) and
   [`LIMITATIONS.md`](LIMITATIONS.md). **built**

## Tests

- `make test` runs the Rust unit, model and sandbox suites plus the TypeScript
  service tests; the command prints the count. **tested**
- `make secret-scan` and `make docs` gate secrets and documentation links.
  **tested**
- `make lint` runs rustfmt, clippy, eslint and prettier. **built**

## More

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system map and the per-invoice account.
- [`api.md`](api.md) — REST contract, mock mode and typed client.
- [`cli.md`](cli.md) — CLI commands, JSON output and exit codes.
- [`TRUST.md`](TRUST.md) — trust assumptions T1–T7 and their mitigations.
- [`COSTS.md`](COSTS.md) — cost table skeleton and measurement method.
- [`LIMITATIONS.md`](LIMITATIONS.md) — what this build does not do.
- [`LEGAL.md`](LEGAL.md) — the legal layer, stated plainly.
