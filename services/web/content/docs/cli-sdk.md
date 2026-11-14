# CLI and SDK

A JSON-first command line for scripts and operations, a typed Node SDK, and a one-tag browser widget.

## CLI

```bash Shell
pnpm --filter @openrail/cli start -- routes --json
pnpm --filter @openrail/cli start -- invoices create --json --dry-run \
  --data '{"invoice_number":"INV-2026-001","issuer_legal_name":"Acme Ltd","debtor_legal_name":"Debtor Co","amount_usd":"12.50","due_date":"2026-12-01","line_items":[{"description":"Design","quantity":1,"unit_amount_usd":"12.50"}]}'
```

Every command has `--json` output and stable exit codes, so it fits in scripts and CI. Writes run by default; add `--dry-run` to preview the request. Destructive commands (`keys rotate`, `keys revoke`) refuse without `--yes`.

> [!NOTE]
> The CLI never signs a transaction. A cash-out prints the exact `near call` for your wallet to sign.

Configuration comes from the environment (`OPENRAIL_API_URL`, `OPENRAIL_API_KEY`). Try it against the mock API with `MOCK=1 pnpm --filter @openrail/api start` in another terminal.

## Node SDK

`@openrail/node` wraps the typed `@openrail/api-client` and adds webhook verification. It has no HTTP stack of its own.

```ts TypeScript
import { createOpenrail, verifyWebhook } from "@openrail/node";

const openrail = createOpenrail({
  baseUrl: process.env.OPENRAIL_API_URL!,
  apiKey: process.env.OPENRAIL_API_KEY!,
});

const invoice = await openrail.invoices.create(
  {
    invoice_number: "INV-2026-001",
    issuer_legal_name: "Acme Ltd",
    debtor_legal_name: "Debtor Co",
    amount_usd: "12.50",
    due_date: "2026-12-01",
    line_items: [{ description: "Design", quantity: 1, unit_amount_usd: "12.50" }],
  },
  { idempotencyKey: "invoice-2026-001" },
);

// In your webhook handler:
const ok = verifyWebhook(rawBody, signatureHeader, process.env.OPENRAIL_WEBHOOK_SECRET!, 300);
```

The same idempotency key with the same body returns the first response; with another body it returns `409`.

## Browser widget

```html HTML
<script src="https://<your pay origin>/widget.js" data-invoice="c-1"></script>
```

The script adds a **Pay invoice** button after the tag; clicking it opens the hosted pay page in a dialog. Options: `data-invoice` (required), `data-pay-url` (the hosted pay origin) and `data-label` (the button text). The dialog closes on Esc, the close button or a backdrop click, and when the pay page reports the payment complete. It is one dependency-free file under 6 KB gzipped, styled with `--openrail-*` custom properties.
