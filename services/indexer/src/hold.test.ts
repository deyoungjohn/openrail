import { describe, expect, it } from "vitest";
import { createIndexerApp } from "./http.js";
import { Indexer } from "./indexer.js";
import { statementRows } from "./statements.js";
import { FakeSource, memoryStore, ROOT, silentLogger } from "./test-support.js";

const log = (event: string, data: Record<string, unknown>): string =>
  `EVENT_JSON:${JSON.stringify({ standard: "openrail", version: "1.0.0", event, data: [data] })}`;
const base = 1_793_613_600;

function ingest(hold: Record<string, unknown>) {
  const store = memoryStore();
  store.ingestBlock({
    height: 1,
    hash: "h1",
    timestamp: base * 1_000_000_000,
    receipts: [
      {
        receiptId: "r1",
        txHash: "tx1",
        predecessorId: "",
        receiverId: ROOT,
        logs: [
          log("issue", {
            token_id: "c-1",
            kind: 0,
            issuer_id: "acme.near",
            owner_id: "acme.near",
            debtor: { Near: "client.near" },
            terms_hash: "0x" + "a".repeat(64),
            amount_due: "100",
            due_date: base + 86_400,
          }),
        ],
      },
    ],
  });
  store.ingestBlock({
    height: 2,
    hash: "h2",
    timestamp: (base + 60) * 1_000_000_000,
    receipts: [
      {
        receiptId: "r2",
        txHash: "tx2",
        predecessorId: "",
        receiverId: ROOT,
        logs: [
          log("booked", {
            token_id: "c-1",
            payment: "100",
            surplus: "0",
            fee: "1",
            credit: "0",
            legs: [{ Hold: hold }],
          }),
        ],
      },
    ],
  });
  return store;
}

describe("Hold legs", () => {
  it("stores a Hold with asset and does not count it as paid out", async () => {
    const store = ingest({ module_id: "example", amount: "99", asset: "nep141:usdc" });
    const rows = await statementRows(store, {
      from: "2026-11-01",
      to: "2026-11-30",
      format: "csv",
    });
    expect(rows[0]).toMatchObject({
      booked_total: 100n,
      fee_total: 1n,
      distributed_total: 0n,
    });
    expect(store.analytics()).toMatchObject({
      paid_out_total: "0",
      held_total: "99",
    });
    const app = createIndexerApp({
      store,
      indexer: new Indexer({ source: new FakeSource([]), store, logger: silentLogger() }),
      rootAccount: ROOT,
    });
    const receipt = await app.handle("GET", "/r/tx2");
    expect(receipt.status).toBe(200);
    expect(receipt.body).toMatchObject({ receipt: { amount: "100", asset: "nep141:usdc" } });

    // The booked event itself is stored with the asset on the Hold leg.
    const events = store.eventsAfter(0, 10);
    const booked = events.find((event) => event.event === "booked");
    expect(booked?.data_json).toContain('"asset":"nep141:usdc"');
  });

  it("still accepts an old Hold leg without asset", async () => {
    const store = ingest({ module_id: "example", amount: "99" });
    const rows = await statementRows(store, {
      from: "2026-11-01",
      to: "2026-11-30",
      format: "csv",
    });
    expect(rows[0]).toMatchObject({ booked_total: 100n, distributed_total: 0n });
  });
});
