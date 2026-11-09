import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
import { createMemoryStores } from "./stores.js";

// The pay page and the ack page show what the client is paying for, and a paid invoice shows its history: the
// lines, the day it was issued and paid, and the transactions from issue to payment.

function world() {
  const auth = new AuthStore(() => Date.now());
  const key = auth.createApiKey("alpha.near", "key", "secret", ["invoices:write"]).secret;
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
    clock: () => new Date("2026-11-09T12:00:00Z"),
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
  return { app, get, create, store: stores.api, setStatus: (s: string) => (status = s) };
}

type Public = {
  line_items: { description: string }[];
  issued_at: string;
  issue_tx: string | null;
  paid_at: string | null;
  payments: { tx_hash: string; near?: boolean }[];
};

describe("the public pay and ack answers", () => {
  it("carry the lines, the issue date and the issue transaction of a new invoice", async () => {
    const w = world();
    expect((await w.create()).status).toBe(201);
    for (const path of ["/v1/pay/claims/c-1", "/v1/ack/c-1"]) {
      const r = await w.get(path);
      expect(r.status, path).toBe(200);
      const body = r.body as Public;
      expect(
        body.line_items.map((i) => i.description),
        path,
      ).toEqual(["Blue shirt", "Postage"]);
      expect(body.issued_at, path).toBe("2026-11-09T12:00:00.000Z");
      expect(body.issue_tx, path).toBe("ISSUETX111");
    }
  });

  it("show when it was paid and the transactions from the payer to the payout", async () => {
    const w = world();
    await w.create();
    w.setStatus("Paid");
    w.store.saveReceipt("rcpt_1", "c-1", "BOOKTX222", {
      id: "rcpt_1",
      token_id: "c-1",
      time: "2026-11-09T12:30:00Z",
      origin_tx: { chain: "base", hash: "0xORIGIN" },
      near_tx_hashes: ["NEARTX333"],
    });
    const body = (await w.get("/v1/pay/claims/c-1")).body as Public;
    expect(body.paid_at).toBe("2026-11-09T12:30:00Z");
    expect(body.payments).toEqual([
      { tx_hash: "0xORIGIN", near: false },
      { tx_hash: "NEARTX333", near: true },
    ]);
  });

  it("an unpaid invoice has no payment date and no payments", async () => {
    const w = world();
    await w.create();
    const body = (await w.get("/v1/pay/claims/c-1")).body as Public;
    expect(body.paid_at).toBeNull();
    expect(body.payments).toEqual([]);
  });

  it("still shows the booking transaction when the provider's evidence is missing", async () => {
    const w = world();
    await w.create();
    w.setStatus("Paid");
    w.store.saveReceipt("rcpt_2", "c-1", "BOOKTX444", {
      id: "rcpt_2",
      token_id: "c-1",
      time: "2026-11-09T13:00:00Z",
      origin_tx: null,
      near_tx_hashes: [],
      booking_tx: "BOOKTX444",
    });
    const body = (await w.get("/v1/pay/claims/c-1")).body as Public;
    expect(body.payments).toEqual([{ tx_hash: "BOOKTX444", near: true }]);
    expect(body.paid_at).toBe("2026-11-09T13:00:00Z");
  });
});
