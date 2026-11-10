import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ApiError, OpenrailClient, createClient, type FetchLike } from "./client";

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
    expect(init.credentials).toBe("include");
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

  it("lists payments", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(fixture("payments.list.json")));
    const client = new OpenrailClient({ baseUrl: "https://api.openrail.near", fetchImpl });

    const payments = await client.payments.list();

    expect(payments.data[0]?.amount).toBe("12500000");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.openrail.near/v1/payments");
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

  it("verifies a NEP-413 challenge and returns a session token", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(fixture("auth.verify.json")));
    const client = new OpenrailClient({ baseUrl: "https://api.openrail.near", fetchImpl });

    const session = await client.auth.verify({
      account_id: "acme.openrail.near",
      public_key: "ed25519:example",
      signature: "signature",
      nonce: "nonce",
    });

    expect(session.session_token.startsWith("or_sess_")).toBe(true);
    expect(session.account_id).toBe("acme.openrail.near");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.openrail.near/v1/auth/verify");
  });

  it("uses a dashboard session bearer for business and API-key calls", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(fixture("business.get.json")))
      .mockResolvedValueOnce(jsonResponse(fixture("api_keys.create.json"), 201));
    const client = new OpenrailClient({
      baseUrl: "https://api.openrail.near",
      apiKey: "or_sess_example",
      fetchImpl,
    });

    await client.business.get();
    const key = await client.apiKeys.create(
      { name: "Production" },
      { idempotencyKey: "idem-key-0001" },
    );

    expect(key.secret).toBe("or_sk_live_example_shown_once");
    const first = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const second = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(headersOf(first).authorization).toBe("Bearer or_sess_example");
    expect(headersOf(second)["Idempotency-Key"]).toBe("idem-key-0001");
  });

  it("passes statement filters and reads a cash-out quote", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(fixture("statements.get.json")))
      .mockResolvedValueOnce(jsonResponse(fixture("cashout.quote.json"), 201));
    const client = new OpenrailClient({ baseUrl: "https://api.openrail.near", fetchImpl });

    const statement = await client.statements.get({
      from: "2026-11-01",
      to: "2026-11-30",
      format: "csv",
    });
    await client.cashout.quote({
      amount: "2000000",
      destination_chain: "base",
      address: "0x" + "e".repeat(40),
      source_asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    });

    expect(statement.format).toBe("csv");
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get("format")).toBe("csv");
  });

  it("relays an EVM acknowledgement", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(fixture("ack.evm.json")));
    const client = new OpenrailClient({ baseUrl: "https://api.openrail.near", fetchImpl });

    const result = await client.ack.evm(
      "c-1",
      { chain_id: 8453, signature: "0xsig" },
      { idempotencyKey: "ack-key-0001" },
    );

    expect(result.tx_hash).toBeDefined();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.openrail.near/v1/ack/c-1/evm");
    expect(headersOf(fetchImpl.mock.calls[0]?.[1] as RequestInit)["Idempotency-Key"]).toBe(
      "ack-key-0001",
    );
  });

  it("reads and clears the cookie-backed session", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(fixture("auth.session.json")))
      .mockResolvedValueOnce(jsonResponse(fixture("auth.logout.json")));
    const client = new OpenrailClient({ baseUrl: "https://api.openrail.near", fetchImpl });

    const session = await client.auth.session();
    const logout = await client.auth.logout({ idempotencyKey: "logout-key-01" });

    expect(session.account_id).toBe("acme.openrail.near");
    expect(logout.ok).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.openrail.near/v1/auth/session");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://api.openrail.near/v1/auth/logout");
  });

  it("reads the health probe", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(fixture("health.json")));
    const client = new OpenrailClient({ baseUrl: "https://api.openrail.near", fetchImpl });

    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.openrail.near/v1/health");
  });

  it("reads analytics", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(fixture("analytics.json")));
    const client = new OpenrailClient({ baseUrl: "https://api.openrail.near", fetchImpl });
    const analytics = await client.analytics();
    expect(analytics.sample.paid).toBe(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.openrail.near/v1/analytics");
  });

  it("serves the OpenAPI document", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ openapi: "3.1.0" }));
    const client = new OpenrailClient({ baseUrl: "https://api.openrail.near", fetchImpl });

    await expect(client.openapi()).resolves.toEqual({ openapi: "3.1.0" });
  });
});
