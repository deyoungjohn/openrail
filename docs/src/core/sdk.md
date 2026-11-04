# SDK and browser widget

Status: both are **built** in `@openrail/node` and `packages/widget`.

## `@openrail/node`

The SDK reuses the typed `@openrail/api-client` and adds webhook verification. It has no
HTTP stack of its own.

```ts
import { createOpenrail } from "@openrail/node";

const openrail = createOpenrail({
  baseUrl: process.env.OPENRAIL_API_URL!,
  apiKey: process.env.OPENRAIL_API_KEY!,
});

const invoice = await openrail.invoices.create(
  {
    invoice_number: "INV-2026-001",
    issuer_legal_name: "Acme Ltd",
    debtor_legal_name: "Debtor Co",
    debtor_key: "debtor.openrail.near",
    amount_usd: "12.50",
    due_date: "2026-12-01",
    line_items: [{ description: "Design", quantity: 1, unit_amount_usd: "12.50" }],
  },
  { idempotencyKey: "invoice-2026-001" },
);
```

→ run against `MOCK=1 pnpm --filter @openrail/api start` and see the
`invoices.create.json` fixture (`token_id: "c-1"`).
→ `openrail.invoices.get(id)` and `openrail.invoices.list({ limit })` return the typed
`InvoiceDetail` and `InvoiceList` shapes.
→ repeat the create with the same `idempotencyKey`; the API returns the first response,
and the same key with another body returns `409`.

### Verify a webhook

```ts
import { verifyWebhook } from "@openrail/node";

const ok = verifyWebhook(
  rawBody,
  request.headers["openrail-signature"],
  process.env.OPENRAIL_WEBHOOK_SECRET!,
  300,
);
```

The header is `Openrail-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>`.
Verify the raw body before parsing it. A tampered body, a malformed header or a timestamp
outside the tolerance is rejected.

## Browser widget

```html
<script src="https://pay.example.com/widget.js" data-invoice="c-1"></script>
```

→ the script adds a `Pay invoice` button after the tag.
→ click it and see the hosted pay page in a dialog.

Options:

- `data-invoice` (required): claim token id.
- `data-pay-url`: hosted pay origin; defaults to the script origin.
- `data-label`: button text.

The dialog closes on Esc, the close button, a backdrop click, and a
`{type: "openrail:payment-complete"}` (or `"openrail:paid"`) message from the pay origin.
It restores focus to the button. Styling uses `--openrail-*` custom properties; there are
no inline styles. The file is a single dependency-free script under the 6 KB gzipped
budget, enforced by `packages/widget/widget.test.ts`.
