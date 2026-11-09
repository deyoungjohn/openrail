import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
import { createMemoryStores } from "./stores.js";

// Fetch once, keep for good: an invoice that is paid (or cancelled, or closed) never changes again, so what the chain
// and the indexer said about it is saved the first time and answered from the database after that. Only new and
// in-flight invoices cost a call (9 Nov: 376 NearBlocks calls and a daily RPC quota gone, for one user).

const clockMs = { now: Date.parse("2026-11-09T12:00:00Z") };

function world() {
  const auth = new AuthStore(() => Date.now());
  const key = auth.createApiKey("alpha.near", "key", "secret", [
    "invoices:write",
    "invoices:read",
  ]).secret;
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
  const indexer = {
    listReceipts: vi.fn(async () => [
      {
        id: "rcpt_1",
        token_id: "c-1",
        time: "2026-11-09T12:30:00Z",
        origin_tx: { chain: "base", hash: "0xORIGIN" },
        near_tx_hashes: ["NEARTX"],
        booking_tx: "BOOKTX",
      },
    ]),
    issueTx: vi.fn(async () => "ISSUETX"),
    getReceipt: vi.fn(),
    getStatement: vi.fn(),
    listEvents: vi.fn(),
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
    indexer,
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
    contract,
    indexer,
    store: stores.api,
    setStatus: (s: string) => (status = s),
    failReads: () => (failing = true),
  };
}

describe("settled invoices are fetched once", () => {
  it("a paid claim is read from the chain once, never again", async () => {
    const w = world();
    await w.create();
    w.setStatus("Paid");
    for (let i = 0; i < 3; i += 1) {
      expect(((await w.get("/v1/pay/claims/c-1")).body as { status: string }).status).toBe("Paid");
      clockMs.now += 60_000;
    }
    await w.get("/v1/ack/c-1");
    expect(w.contract.claim).toHaveBeenCalledTimes(1);
  });

  it("an open claim is still read again after ten seconds", async () => {
    const w = world();
    await w.create();
    await w.get("/v1/pay/claims/c-1");
    clockMs.now += 60_000;
    await w.get("/v1/pay/claims/c-1");
    expect(w.contract.claim).toHaveBeenCalledTimes(2);
  });

  it("the history of a paid invoice is fetched from the indexer once", async () => {
    const w = world();
    await w.create();
    w.setStatus("Paid");
    for (let i = 0; i < 3; i += 1) {
      const body = (await w.get("/v1/pay/claims/c-1")).body as {
        payments: { tx_hash: string }[];
        issue_tx: string | null;
      };
      expect(body.payments.map((p) => p.tx_hash)).toEqual(["0xORIGIN", "NEARTX", "BOOKTX"]);
      expect(body.issue_tx).toBe("ISSUETX111");
      clockMs.now += 60_000;
    }
    expect(w.indexer.listReceipts).toHaveBeenCalledTimes(1);
  });
});
