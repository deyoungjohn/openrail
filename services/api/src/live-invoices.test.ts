import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
import { createMemoryStores } from "./stores.js";

// A dashboard read while the RPC refuses must not turn a paid invoice back into an outstanding one (9 Nov: the list
// fell back to the record written at creation, "Issued", whenever a claim could not be read).

const clockMs = { now: Date.parse("2026-11-09T12:00:00Z") };

function world() {
  const auth = new AuthStore(() => Date.now());
  const key = auth.createApiKey("alpha.near", "key", "secret", ["invoices:write", "invoices:read"]).secret;
  const stores = createMemoryStores();
  const issuer = {
    prepareIssue: vi.fn(async () => ({ tokenId: "c-1", claimAccount: "c-1.openrail.near" })),
    issueFor: vi.fn(async () => ({ txHash: "ISSUETX111" })),
    logQuote: vi.fn(),
    acknowledgeEvm: vi.fn(),
  };
  let status = "Issued";
  const contract = {
    claim: vi.fn(async () => ({
      token_id: "c-1",
      kind: 0,
      amount_due: "11000000",
      outstanding: status === "Paid" ? "0" : "11000000",
      status,
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
    clock: () => new Date(clockMs.now),
    spec: { openapi: "3.1.0" },
    pokeIndexer: async () => undefined,
  } as unknown as ApiDeps;
  const app = new ApiApp(deps);
  const get = (path: string) =>
    app.handle({ method: "GET", path, query: new URLSearchParams(), headers: {}, body: undefined });
  const create = () =>
    app.handle({
      method: "POST",
      path: "/v1/invoices",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${key}` },
      body: {
        invoice_number: "INV-1",
        issuer_legal_name: "Alpha",
        debtor_legal_name: "Debtor",
        debtor_key: "debtor.near",
        amount_usd: "11.00",
        due_date: "2026-12-01",
        line_items: [
          { description: "Blue shirt", quantity: 2, unit_amount_usd: "5.00" },
          { description: "Postage", quantity: 1, unit_amount_usd: "1.00" },
        ],
      },
    });
  let failing = false;
  contract.claim.mockImplementation(async () => {
    if (failing) throw new Error("RPC_QUOTA_EXCEEDED");
    return {
      token_id: "c-1",
      kind: 0,
      amount_due: "11000000",
      outstanding: status === "Paid" ? "0" : "11000000",
      status,
    };
  });
  return {
    app,
    get,
    create,
    key,
    store: stores.api,
    setStatus: (s: string) => (status = s),
    failReads: () => (failing = true),
  };
}

describe("the invoice list while the chain cannot be read", () => {
  it("keeps the last status it read instead of the one written at creation", async () => {
    const w = world();
    await w.create();
    w.setStatus("Paid");
    const list = () =>
      w.app.handle({
        method: "GET",
        path: "/v1/invoices",
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${w.key}` },
        body: undefined,
      });
    const first = (await list()).body as { data: { status: string }[] };
    expect(first.data[0]?.status).toBe("Paid");
    // The RPC refuses from now on, and the ten-second cache has run out.
    w.failReads();
    clockMs.now += 60_000;
    const second = (await list()).body as { data: { status: string; outstanding: string }[] };
    expect(second.data[0]?.status).toBe("Paid");
    expect(second.data[0]?.outstanding).toBe("0");
  });
});
