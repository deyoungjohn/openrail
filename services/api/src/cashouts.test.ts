import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
import { createMemoryStores } from "./stores.js";

// A merchant's cash-outs: each quote is kept, the signed transaction is attached, and the list and the detail say where
// the money is by asking the provider and the chain.

const SCOPES = ["payments:read", "invoices:read"];

function world() {
  const auth = new AuthStore(() => Date.now());
  const a = auth.createApiKey("alpha.near", "key", "secret", SCOPES).secret;
  const b = auth.createApiKey("bravo.near", "key", "secret", SCOPES).secret;
  const stores = createMemoryStores();
  const cashout = {
    quote: vi.fn(async (r: { amount: string; destinationChain: string; address: string }) => ({
      amount: r.amount,
      source_asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      destination_chain: r.destinationChain,
      destination_address: r.address,
      amount_out: "1990000",
      min_amount_in: r.amount,
      route_cost_usd: "0.01",
      deposit_address: "f".repeat(64),
      deposit_type: "INTENTS",
      swap_type: "EXACT_INPUT",
      route_id: "R1",
      deadline: "2099-01-01T00:00:00.000Z",
    })),
  };
  let providerStatus: Record<string, unknown> = { status: "PENDING_DEPOSIT" };
  const quoteProvider = {
    quote: vi.fn(),
    status: vi.fn(async () => providerStatus),
  };
  let txState: "success" | "failed" | "pending" = "pending";
  const contract = {
    claim: vi.fn(),
    storageCredit: vi.fn(),
    txStatus: vi.fn(async () => txState),
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
    issuer: {},
    contract,
    cashout,
    quoteProvider,
    accessKey: { has: async () => true },
    verifier: () => true,
    clock: () => new Date("2026-11-09T12:00:00Z"),
    spec: { openapi: "3.1.0" },
    pokeIndexer: async () => undefined,
  } as unknown as ApiDeps;
  const app = new ApiApp(deps);
  const call = (secret: string, method: string, path: string, body?: unknown) =>
    app.handle({
      method,
      path,
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": crypto.randomUUID() },
      body,
    });
  return {
    call,
    a,
    b,
    setProvider: (s: Record<string, unknown>) => (providerStatus = s),
    setTx: (s: "success" | "failed" | "pending") => (txState = s),
  };
}

const quoteBody = { amount: "2000000", destination_chain: "base", address: "0x" + "e".repeat(40) };

type View = {
  id: string;
  status: string;
  tx_hash: string | null;
  tx_state: string | null;
  near_tx_hashes: string[];
  destination_tx_hashes: string[];
  amount: string;
  destination_chain: string;
};

describe("cash-outs", () => {
  it("keeps each quote, lists it for its merchant only, and starts as quoted", async () => {
    const w = world();
    const q = await w.call(w.a, "POST", "/v1/cashout/quote", quoteBody);
    expect(q.status).toBe(201);
    const id = (q.body as { id: string }).id;
    expect(id).toMatch(/^co_/);
    const mine = (await w.call(w.a, "GET", "/v1/cashouts")).body as { data: View[] };
    expect(mine.data.map((c) => c.id)).toEqual([id]);
    expect(mine.data[0]).toMatchObject({ status: "quoted", tx_hash: null, amount: "2000000" });
    const theirs = (await w.call(w.b, "GET", "/v1/cashouts")).body as { data: View[] };
    expect(theirs.data).toEqual([]);
    expect((await w.call(w.b, "GET", `/v1/cashouts/${id}`)).status).toBe(404);
  });

  it("attaches the signed transaction, and only its owner may", async () => {
    const w = world();
    const id = ((await w.call(w.a, "POST", "/v1/cashout/quote", quoteBody)).body as { id: string })
      .id;
    expect(
      (
        await w.call(w.b, "POST", `/v1/cashouts/${id}/sent`, {
          tx_hash: "AHr9XT76T7gyToQ42TnHZ2upxVZVLLJbKuyPDjqizYiq",
        })
      ).status,
    ).toBe(404);
    w.setTx("success");
    const sent = await w.call(w.a, "POST", `/v1/cashouts/${id}/sent`, {
      tx_hash: "AHr9XT76T7gyToQ42TnHZ2upxVZVLLJbKuyPDjqizYiq",
    });
    expect(sent.status).toBe(200);
    const view = (await w.call(w.a, "GET", `/v1/cashouts/${id}`)).body as View;
    expect(view).toMatchObject({
      status: "sent",
      tx_hash: "AHr9XT76T7gyToQ42TnHZ2upxVZVLLJbKuyPDjqizYiq",
      tx_state: "success",
    });
  });

  it("follows the provider: processing, then arrived with the destination transaction", async () => {
    const w = world();
    const id = ((await w.call(w.a, "POST", "/v1/cashout/quote", quoteBody)).body as { id: string })
      .id;
    await w.call(w.a, "POST", `/v1/cashouts/${id}/sent`, {
      tx_hash: "AHr9XT76T7gyToQ42TnHZ2upxVZVLLJbKuyPDjqizYiq",
    });
    w.setProvider({
      status: "PROCESSING",
      nearTxHashes: ["AHr9XT76T7gyToQ42TnHZ2upxVZVLLJbKuyPDjqizYiq"],
    });
    expect(((await w.call(w.a, "GET", `/v1/cashouts/${id}`)).body as View).status).toBe(
      "processing",
    );
    w.setProvider({
      status: "SUCCESS",
      nearTxHashes: ["AHr9XT76T7gyToQ42TnHZ2upxVZVLLJbKuyPDjqizYiq"],
      destinationChainTxHashes: ["0xDEST"],
    });
    const done = (await w.call(w.a, "GET", `/v1/cashouts/${id}`)).body as View;
    expect(done.status).toBe("success");
    expect(done.destination_tx_hashes).toEqual(["0xDEST"]);
    expect(done.near_tx_hashes).toEqual(["AHr9XT76T7gyToQ42TnHZ2upxVZVLLJbKuyPDjqizYiq"]);
  });

  it("says refunded or incomplete when the provider does", async () => {
    const w = world();
    const id = ((await w.call(w.a, "POST", "/v1/cashout/quote", quoteBody)).body as { id: string })
      .id;
    w.setProvider({ status: "INCOMPLETE_DEPOSIT" });
    expect(((await w.call(w.a, "GET", `/v1/cashouts/${id}`)).body as View).status).toBe(
      "incomplete",
    );
    w.setProvider({ status: "REFUNDED" });
    expect(((await w.call(w.a, "GET", `/v1/cashouts/${id}`)).body as View).status).toBe("refunded");
  });
});
