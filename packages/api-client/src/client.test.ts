import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ApiError, OpenrailClient, createClient, type FetchLike } from "./client.js";

const FIXTURES = new URL("../../../fixtures/api/", import.meta.url);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

const createBody = {
  invoice_number: "INV-2026-001",
  issuer_legal_name: "Acme Ltd",
  debtor_legal_name: "Debtor Co",
  debtor_key: "debtor.openrail.near",
  amount_usd: "12.50",
  due_date: "2026-12-01",
  line_items: [{ description: "Design", quantity: 1, unit_amount_usd: "12.50" }],
};

describe("typed client", () => {
  it("creates an invoice with auth and an idempotency key", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse(fixture("invoices.create.json"), 201),
    );
    const client = createClient({
      baseUrl: "https://api.openrail.near/",
      apiKey: "or_sk_live_example",
      fetchImpl,
    });

    const invoice = await client.invoices.create(createBody, { idempotencyKey: "idem-12345678" });

    expect(invoice.token_id).toBe("c-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.openrail.near/v1/invoices");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(headersOf(init).authorization).toBe("Bearer or_sk_live_example");
    expect(headersOf(init)["Idempotency-Key"]).toBe("idem-12345678");
    expect(JSON.parse(String(init.body))).toEqual(createBody);
  });

  it("encodes list query parameters", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(fixture("invoices.list.json")));
    const client = new OpenrailClient({ baseUrl: "https://api.openrail.near", fetchImpl });

    await client.invoices.list({ limit: 10, status: "Issued" });

    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v1/invoices");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("status")).toBe("Issued");
  });

  it("raises ApiError with the documented code and rule", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(fixture("error.404.json"), 404));
    const client = new OpenrailClient({ baseUrl: "https://api.openrail.near", fetchImpl });

    const error = await client.invoices.get("missing").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe("invoice_not_found");
  });

  it("does not send Authorization when no key is configured (public pages)", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(fixture("pay.claims.get.json")));
    const client = new OpenrailClient({ baseUrl: "https://api.openrail.near", fetchImpl });

    await client.pay.getClaim("c-1");

    expect(headersOf(fetchImpl.mock.calls[0]?.[1] as RequestInit).authorization).toBeUndefined();
  });

  it("serves the OpenAPI document", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ openapi: "3.1.0" }));
    const client = new OpenrailClient({ baseUrl: "https://api.openrail.near", fetchImpl });

    await expect(client.openapi()).resolves.toEqual({ openapi: "3.1.0" });
  });
});
