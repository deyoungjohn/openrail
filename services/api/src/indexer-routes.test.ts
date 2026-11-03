import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps, type IndexerPort } from "./app.js";
import { AuthStore } from "./auth.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/indexer/${name}`, import.meta.url), "utf8"));
const receipt = (fixture("receipt.json") as { receipt: Record<string, unknown> }).receipt;
const receipts = (fixture("receipts.json") as { receipts: Record<string, unknown>[] }).receipts;
const statement = fixture("statement.json") as Record<string, unknown>;
const invoice = JSON.parse(
  readFileSync(new URL("../../../fixtures/api/invoices.create.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

function appWithIndexer() {
  const auth = new AuthStore();
  const { secret } = auth.createApiKey("acme.openrail.near", "Read", "secret", [
    "invoices:read",
    "receipts:read",
  ]);
  const indexer: IndexerPort = {
    listReceipts: vi.fn(async () => receipts),
    getReceipt: vi.fn(async () => receipt),
    getStatement: vi.fn(async () => statement),
    listEvents: vi.fn(async () => ({
      data: [{ id: "7", type: "booked", created: 1762077695, data: { token_id: "c-1" } }],
      next_cursor: "7",
    })),
  };
  const deps: ApiDeps = {
    config: {
      rootAccount: "openrail.near",
      recipient: "api.openrail.near",
      payBaseUrl: "https://pay.openrail.near",
    },
    auth,
    issuer: {
      prepareIssue: async () => ({ tokenId: "c-1", claimAccount: "c-1.openrail.near" }),
      issueFor: async () => ({ txHash: "0xissue" }),
      logQuote: async () => ({ txHash: "0xquote" }),
      acknowledgeEvm: async () => ({ txHash: "0xack", ack: {} }),
    },
    contract: {
      claim: async () => ({
        token_id: "c-1",
        kind: 0,
        claim_account: "c-1.openrail.near",
        terms_hash: invoice.terms_hash,
        amount_due: invoice.amount_due,
        outstanding: invoice.amount_due,
      }),
      storageCredit: async () => ({ balance: "0", amount: "0" }),
    },
    accessKey: { has: async () => true },
    cashout: { quote: async () => ({}) },
    indexer,
    verifier: () => true,
    spec: {},
  };
  const app = new ApiApp(deps);
  app.store.saveInvoice(invoice as never);
  return { app, indexer, secret };
}

function request(method: string, path: string, secret: string, query = "") {
  return {
    method,
    path,
    query: new URLSearchParams(query),
    headers: { authorization: `Bearer ${secret}` },
    body: undefined,
  };
}

describe("receipt and statement routes use the indexer port", () => {
  it("lists receipts from the recorded indexer fixture", async () => {
    const { app, indexer, secret } = appWithIndexer();
    const response = await app.handle(request("GET", "/v1/invoices/c-1/receipts", secret));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: receipts });
    expect(indexer.listReceipts).toHaveBeenCalledWith("acme.openrail.near", "c-1");
  });

  it("serves a public receipt by booking hash from the indexer", async () => {
    const { app, indexer } = appWithIndexer();
    const response = await app.handle(
      request("GET", `/v1/receipts/${String(receipt.booking_tx_hash)}`, ""),
    );
    expect(response.status).toBe(200);
    const body = response.body as { receipt: { id: string }; verify_url: string };
    expect(body.receipt.id).toBe(receipt.id);
    expect(body.verify_url).toContain(String(receipt.booking_tx_hash));
    expect(indexer.getReceipt).toHaveBeenCalledWith(receipt.booking_tx_hash);
  });

  it("lists events from the indexer cursor", async () => {
    const { app, indexer, secret } = appWithIndexer();
    const response = await app.handle(
      request("GET", "/v1/events", secret, "cursor=3&type=booked&limit=10"),
    );
    expect(response.status).toBe(200);
    expect((response.body as { data: { id: string }[] }).data[0]?.id).toBe("7");
    expect(indexer.listEvents).toHaveBeenCalledWith({ after: "3", type: "booked", limit: 10 });
  });

  it("returns the indexer statement envelope with the query", async () => {
    const { app, indexer, secret } = appWithIndexer();
    const response = await app.handle(
      request(
        "GET",
        "/v1/statements",
        secret,
        "format=csv&token_id=c-1&from=2026-11-01&to=2026-11-30",
      ),
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual(statement);
    expect(indexer.getStatement).toHaveBeenCalledWith("acme.openrail.near", {
      format: "csv",
      tokenId: "c-1",
      from: "2026-11-01",
      to: "2026-11-30",
    });
  });
});
