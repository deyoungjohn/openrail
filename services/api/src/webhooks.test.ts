import { describe, expect, it, vi } from "vitest";
import { hmacSha256Hex } from "./crypto.js";
import {
  WebhookNotIndexed,
  deliverTestWebhook,
  deliverWebhook,
  signWebhook,
  type IndexedEvent,
} from "./webhooks.js";

const endpoint = {
  id: "whe_1",
  url: "https://example.com/hook",
  secret: "whsec_test",
  events: ["invoice.paid"],
};
const event: IndexedEvent = {
  id: "evt_1",
  type: "invoice.paid",
  created: 1762070495,
  data: { invoice_id: "inv_1" },
  indexed: true,
};

describe("webhook signatures", () => {
  it("signs t + '.' + body with HMAC-SHA256", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const signature = signWebhook("whsec_test", 1762070495, body);
    expect(signature).toBe(`t=1762070495,v1=${hmacSha256Hex("whsec_test", `1762070495.${body}`)}`);
  });

  it("delivers an indexed event with the signature header", async () => {
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 }),
    );
    const result = await deliverWebhook(endpoint, event, {
      fetchImpl,
      validateUrl: async () => undefined,
      clock: () => 1762070495000,
    });
    expect(result.statusCode).toBe(200);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    expect(headers["Openrail-Signature"]).toBe(signWebhook(endpoint.secret, 1762070495, body));
  });

  it("refuses a blocked delivery URL", async () => {
    await expect(
      deliverWebhook(endpoint, event, {
        fetchImpl: async () => new Response("ok", { status: 200 }),
        validateUrl: async () => {
          throw new Error("webhook address is not public");
        },
      }),
    ).rejects.toThrow("not public");
  });

  it("treats a redirect as a failed delivery", async () => {
    const result = await deliverWebhook(endpoint, event, {
      fetchImpl: async () => new Response("moved", { status: 302 }),
      validateUrl: async () => undefined,
    });
    expect(result.statusCode).toBe(302);
  });

  it("refuses a non-indexed event", async () => {
    await expect(
      deliverWebhook(endpoint, { ...event, indexed: false } as unknown as IndexedEvent),
    ).rejects.toBeInstanceOf(WebhookNotIndexed);
  });

  it("sends a signed test event", async () => {
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 202 }),
    );
    const result = await deliverTestWebhook(
      endpoint,
      { id: "evt_test", type: "invoice.paid", created: 1, data: { test: true } },
      { fetchImpl, validateUrl: async () => undefined, clock: () => 1000 },
    );
    expect(result.statusCode).toBe(202);
  });
});
