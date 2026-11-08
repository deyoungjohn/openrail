import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
import { createMemoryStores } from "./stores.js";

// A merchant sees its own invoices, payments and events and nothing of another merchant's. These tests found a real
// leak (8 Nov): the events list and every invoice route answered for any signed-in merchant.

const SCOPES = ["invoices:read", "invoices:write", "payments:read", "receipts:read"];

function world() {
  const auth = new AuthStore(() => Date.now());
  const a = auth.createApiKey("alpha.near", "key", "secret", SCOPES).secret;
  const b = auth.createApiKey("bravo.near", "key", "secret", SCOPES).secret;
  const stores = createMemoryStores();
  const issuer = {
    prepareIssue: vi.fn(async () => ({ tokenId: "c-1", claimAccount: "c-1.openrail.near" })),
    issueFor: vi.fn(async () => ({ txHash: "0xissue" })),
    logQuote: vi.fn(),
    acknowledgeEvm: vi.fn(),
  };
  const contract = {
    claim: vi.fn(async () => ({
      token_id: "c-1",
      kind: 0,
      amount_due: "1000000",
      outstanding: "1000000",
      status: "Issued",
    })),
    storageCredit: vi.fn(async () => ({ balance: "0", amount: "0" })),
  };
  const deps = {
    config: {
      rootAccount: "openrail.near",
      payBaseUrl: "https://pay.openrail.near",
      recipient: "openrail.near",
      deployment: "test",
    },
    auth,
    store: stores.api,
    issuer,
    contract,
    accessKey: { has: async () => true },
    verifier: () => true,
    clock: () => new Date("2026-11-08T12:00:00Z"),
    spec: { openapi: "3.1.0" },
    pokeIndexer: async () => undefined,
  } as unknown as ApiDeps;
  const app = new ApiApp(deps);
  const call = (secret: string, method: string, path: string, body?: unknown) =>
    app.handle({
      method,
      path,
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${secret}` },
      body,
    });
  return { app, a, b, call, store: stores.api };
}

const invoiceBody = {
  invoice_number: "INV-1",
  issuer_legal_name: "Alpha",
  debtor_legal_name: "Debtor",
  debtor_key: "debtor.near",
  amount_usd: "1.00",
  due_date: "2026-12-01",
  line_items: [{ description: "Work", quantity: 1, unit_amount_usd: "1.00" }],
};

describe("a merchant cannot read another merchant's data", () => {
  it("invoice routes answer 404 for an invoice that is not yours, and 200 for your own", async () => {
    const w = world();
    const made = await w.call(w.a, "POST", "/v1/invoices", invoiceBody);
    expect(made.status).toBe(201);
    const id = (made.body as { id: string }).id;
    for (const suffix of ["", "/pdf", "/receipts", "/open_quotes"]) {
      const mine = await w.call(w.a, "GET", `/v1/invoices/${id}${suffix}`);
      expect(mine.status, `own ${suffix}`).toBe(200);
      const theirs = await w.call(w.b, "GET", `/v1/invoices/${id}${suffix}`);
      expect(theirs.status, `other ${suffix}`).toBe(404);
      // by claim id too
      const byToken = await w.call(w.b, "GET", `/v1/invoices/c-1${suffix}`);
      expect(byToken.status, `other by token ${suffix}`).toBe(404);
    }
  });

  it("the events list holds only the events of your own claims", async () => {
    const w = world();
    await w.call(w.a, "POST", "/v1/invoices", invoiceBody);
    w.store.appendEvent({ id: "1", type: "booked", created: 1, data: { token_id: "c-1" } });
    w.store.appendEvent({ id: "2", type: "booked", created: 2, data: { token_id: "c-99" } });
    const mine = await w.call(w.a, "GET", "/v1/events");
    expect((mine.body as { data: { id: string }[] }).data.map((e) => e.id)).toEqual(["1"]);
    const theirs = await w.call(w.b, "GET", "/v1/events");
    expect((theirs.body as { data: unknown[] }).data).toEqual([]);
  });

  it("a payment is readable only by the merchant it belongs to", async () => {
    const w = world();
    const store = w.store as unknown as {
      savePayment: (id: string, body: Record<string, unknown>) => void;
    };
    store.savePayment("pay_1", { id: "pay_1", issuer_id: "alpha.near", amount: "1" });
    expect((await w.call(w.a, "GET", "/v1/payments/pay_1")).status).toBe(200);
    expect((await w.call(w.b, "GET", "/v1/payments/pay_1")).status).toBe(404);
  });
});
