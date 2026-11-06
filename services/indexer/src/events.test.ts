import { describe, expect, it } from "vitest";
import { createIndexerApp } from "./http.js";
import { Indexer } from "./indexer.js";
import { FakeSource, memoryStore, ROOT, silentLogger } from "./test-support.js";

const log = (event: string, data: Record<string, unknown>): string =>
  `EVENT_JSON:${JSON.stringify({ standard: "openrail", version: "1.0.0", event, data: [data] })}`;
const block = (height: number, event: string, data: Record<string, unknown>) => ({
  height,
  hash: `h${height}`,
  timestamp: (1_793_613_600 + height) * 1_000_000_000,
  receipts: [
    {
      receiptId: `r${height}`,
      txHash: `tx${height}`,
      predecessorId: "",
      receiverId: ROOT,
      logs: [log(event, data)],
    },
  ],
});

describe("REL-1 events", () => {
  it("stores storage_sponsored and lists it through /events", async () => {
    const store = memoryStore();
    store.ingestBlock(
      block(1, "storage_sponsored", { business: "acme.near", amount: "20000000000000000000000" }),
    );
    const events = store.eventsAfter(0, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("storage_sponsored");
    expect(events[0]?.data_json).toContain("acme.near");
    const app = createIndexerApp({
      store,
      indexer: new Indexer({ source: new FakeSource([]), store, logger: silentLogger() }),
      rootAccount: ROOT,
    });
    const response = await app.handle("GET", "/events?after=0&limit=10");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ data: [{ event: "storage_sponsored" }] });
  });

  it("stores an unknown event raw and keeps advancing the cursor", async () => {
    const blocks = [
      block(1, "issue", {
        token_id: "c-1",
        kind: 0,
        issuer_id: "acme.near",
        owner_id: "acme.near",
        debtor: { Near: "client.near" },
        terms_hash: "0x" + "a".repeat(64),
        amount_due: "100",
        due_date: 1_793_700_000,
      }),
      block(2, "module_mystery", { token_id: "c-1", payload: { a: 1 } }),
      block(3, "ack", { token_id: "c-1", scheme: { Near: { account: "client.near" } }, block: 2 }),
    ];
    const store = memoryStore();
    const indexer = new Indexer({
      source: new FakeSource(blocks, 3),
      store,
      logger: silentLogger(),
      maxPagesPerSync: 10,
    });
    const result = await indexer.syncOnce();
    expect(result.latest_block).toBe(3);
    expect(store.cursor()?.height).toBe(3);
    expect(store.eventsAfter(0, 10).map((event) => event.event)).toEqual([
      "issue",
      "module_mystery",
      "ack",
    ]);
  });
});
