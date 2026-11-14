# Webhooks

Openrail tells your systems when something happens to your invoices and checkouts, with a signed HTTP request built only from events indexed from the chain.

## Register an endpoint

In **API Integration → Webhooks**, choose **Add endpoint**, enter an `https:` URL and the events to receive. The signing secret is shown once (it starts with `whsec_`). Over the API:

```bash curl
curl -s -X POST "$API/v1/webhook_endpoints" \
  -H "Authorization: Bearer $OPENRAIL_SECRET_KEY" \
  -H "content-type: application/json" \
  -d '{"url":"https://shop.example/openrail/webhook","events":["checkout.paid","checkout.paid_late"]}'
```

`GET /v1/webhook_event_types` lists the types this deployment can deliver. Each endpoint has **Send test event** and a **Delivery log** (`GET /v1/webhook_endpoints/{id}/deliveries`).

## The request

```json Body
{
  "id": "…",
  "type": "checkout.paid",
  "created": 1794599245,
  "data": {
    "order_ref": "1042",
    "checkout_id": "acme-3f2a9c41d07b",
    "amount_usd": "48.50",
    "total_usd": "48.50",
    "status": "paid",
    "transactions": { "origin": "0x8f3a…", "booking": "4SsR6oVP…" }
  }
}
```

## Verify the signature

Every delivery has the header `Openrail-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is the HMAC-SHA256 of `t + "." + rawBody` with your endpoint's secret. Verify the **raw** body before parsing it, and refuse a timestamp more than 5 minutes away.

```ts Node.js (SDK)
import { verifyWebhook } from "@openrail/node";

const ok = verifyWebhook(
  rawBody,
  req.headers["openrail-signature"],
  process.env.OPENRAIL_WEBHOOK_SECRET!,
  300,
);
if (!ok) return res.status(401).end();
```

```php PHP
[$t, $v1] = array_map(fn ($p) => explode('=', $p, 2)[1], explode(',', $header));
$ok = abs(time() - (int) $t) <= 300
  && hash_equals(hash_hmac('sha256', $t . '.' . $raw, $secret), $v1);
```

## Delivery and retries

- Deliveries come only from indexed events, so a webhook always matches something on the chain.
- A delivery that does not get a `2xx` is retried for **24 hours**.
- Events can arrive more than once: use `id` (and for checkouts `order_ref`) to make your handler idempotent. Checkout events are deduplicated by `sha256(token_id ‖ booking_seq)`.
- Answer quickly with `2xx` and do slow work afterwards.

## Event types

See [Event types](/docs/events) for every type and its data. Checkout events are delivered today; the `invoice.*` names are not mapped yet (see the note there).
