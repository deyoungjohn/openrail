/** HMAC-signed webhooks, delivered only from indexed events (blueprint 1.7/2.9). */
import { hmacSha256Hex } from "./crypto.js";
import { safeWebhookFetch, validateWebhookUrl } from "./webhook-url.js";

export interface WebhookEndpointRecord {
  id: string;
  url: string;
  secret: string;
  events: string[];
  created_at?: string;
}

export interface IndexedEvent {
  id: string;
  type: string;
  created: number;
  data: Record<string, unknown>;
  indexed: true;
}

export interface WebhookDelivery {
  statusCode: number;
  body: string;
}

export class WebhookNotIndexed extends Error {
  override readonly name = "WebhookNotIndexed";

  constructor() {
    super("WEBHOOK_NOT_INDEXED: only indexed events may be delivered");
  }
}

/** `Openrail-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>` */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export interface DeliveryOptions {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  validateUrl?: (url: string) => Promise<unknown>;
  clock?: () => number;
}

export async function deliverWebhook(
  endpoint: WebhookEndpointRecord,
  event: IndexedEvent,
  options: DeliveryOptions = {},
): Promise<WebhookDelivery> {
  if (event.indexed !== true) throw new WebhookNotIndexed();
  if (!endpoint.events.includes(event.type)) return { statusCode: 0, body: "event not subscribed" };
  await (options.validateUrl ?? validateWebhookUrl)(endpoint.url);
  const body = JSON.stringify({
    id: event.id,
    type: event.type,
    created: event.created,
    data: event.data,
  });
  const timestamp = Math.floor((options.clock ?? Date.now)() / 1000);
  const fetchImpl = options.fetchImpl ?? safeWebhookFetch;
  const response = await fetchImpl(endpoint.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Openrail-Signature": signWebhook(endpoint.secret, timestamp, body),
    },
    body,
  });
  return { statusCode: response.status, body: await response.text() };
}

/** The explicit test endpoint may send a synthetic event; it is still signed. */
export async function deliverTestWebhook(
  endpoint: WebhookEndpointRecord,
  event: Omit<IndexedEvent, "indexed">,
  options: DeliveryOptions = {},
): Promise<WebhookDelivery> {
  return deliverWebhook(endpoint, { ...event, indexed: true }, options);
}
