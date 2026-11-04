# @openrail/node

Typed Openrail client plus webhook verification. It reuses `@openrail/api-client`; no
new HTTP stack and no dependency beyond Node's crypto.

## Do X → see Y

```bash
export OPENRAIL_API_URL=http://127.0.0.1:8787
export OPENRAIL_API_KEY=or_sk_live_example_not_a_real_key
```

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

→ against `MOCK=1 pnpm --filter @openrail/api start`, see the `invoices.create.json` fixture
(`token_id: "c-1"`). `invoices.get(id)` and `invoices.list(query)` are typed the same way.

## Verify a webhook

```ts
import { verifyWebhook } from "@openrail/node";

const ok = verifyWebhook(
  rawBody, // the exact string received
  request.headers["openrail-signature"],
  process.env.OPENRAIL_WEBHOOK_SECRET!,
  300, // replay tolerance in seconds
);
```

The header is `Openrail-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>`.
The verifier rejects a tampered body, a malformed header, and a timestamp outside the
tolerance. Always verify the raw body before parsing it.
