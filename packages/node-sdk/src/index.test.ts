import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createOpenrail, verifyWebhook } from "./index.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/api/${name}`, import.meta.url), "utf8"));

function signature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

describe("invoices", () => {
  it("reuses the typed client and forwards the idempotency key", async () => {
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify(fixture("invoices.create.json")), { status: 201 }),
    );
    const openrail = createOpenrail({
      baseUrl: "https://api.openrail.near",
      apiKey: "or_sk_live_test",
      fetchImpl,
    });
    const invoice = await openrail.invoices.create(
      {
        invoice_number: "INV-1",
        issuer_legal_name: "Acme Ltd",
        debtor_legal_name: "Debtor Co",
        debtor_key: "debtor.openrail.near",
        amount_usd: "12.50",
        due_date: "2026-12-01",
        line_items: [{ description: "Design", quantity: 1, unit_amount_usd: "12.50" }],
      },
      { idempotencyKey: "idem-0001" },
    );
    expect(invoice.token_id).toBe("c-1");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-0001");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer or_sk_live_test");
  });

  it("gets and lists invoices", async () => {
    const fetchImpl = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture("invoices.get.json")), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture("invoices.list.json")), { status: 200 }),
      );
    const openrail = createOpenrail({ baseUrl: "https://api.openrail.near", fetchImpl });
    const detail = await openrail.invoices.get("c-1");
    const list = await openrail.invoices.list({ limit: 10 });
    expect(detail.invoice.token_id).toBe("c-1");
    expect(list.data.length).toBeGreaterThan(0);
  });
});

describe("webhook verification", () => {
  const secret = "whsec_test";
  const payload = { id: "evt_1", type: "invoice.paid", data: { token_id: "c-1" } };
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const header = `t=${timestamp},v1=${signature(secret, timestamp, body)}`;

  it("accepts a valid signature", () => {
    expect(verifyWebhook(payload, header, secret)).toBe(true);
    expect(verifyWebhook(body, header, secret, 300)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyWebhook({ ...payload, data: { token_id: "c-2" } }, header, secret)).toBe(false);
  });

  it("rejects an old timestamp", () => {
    const old = timestamp - 301;
    expect(verifyWebhook(body, `t=${old},v1=${signature(secret, old, body)}`, secret, 300)).toBe(
      false,
    );
  });

  it("rejects a malformed header", () => {
    expect(verifyWebhook(body, "nope", secret)).toBe(false);
    expect(verifyWebhook(body, `t=${timestamp},v1=zz`, secret)).toBe(false);
  });
});
