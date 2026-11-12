import { describe, expect, it } from "vitest";
import { BOOST_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, Indexer } from "./indexer.js";
import {
  FakeEnricher,
  FakeSource,
  RecordingSink,
  ROOT,
  loadBlocks,
  memoryStore,
  silentLogger,
} from "./test-support.js";

function fixture(options: { enricher?: boolean } = {}) {
  const blocks = loadBlocks();
  const store = memoryStore();
  const source = new FakeSource(blocks);
  const sink = new RecordingSink();
  const enricher = options.enricher === false ? undefined : new FakeEnricher();
  const indexer = new Indexer({
    source,
    store,
    sink,
    ...(enricher === undefined ? {} : { enricher }),
    maxPagesPerSync: 10,
    logger: silentLogger(),
    now: () => 1_800_000_000_000,
  });
  return { blocks, store, source, sink, enricher, indexer };
}

describe("boost", () => {
  it("a poke while already boosted does not extend the boost, and idle polling is slow", () => {
    // 9 Nov: 376 NearBlocks calls in a day for one user: a tick every 5 minutes round the clock, and every poke
    // (each price, each cash-out) started five more minutes of ticks every 20 seconds.
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(BOOST_POLL_INTERVAL_MS).toBe(60_000);
    let now = 1_000_000;
    const indexer = new Indexer({
      source: new FakeSource(loadBlocks()),
      store: memoryStore(),
      logger: silentLogger(),
      now: () => now,
    });
    const first = indexer.poke();
    now += 2 * 60 * 1000;
    expect(indexer.poke()).toBe(first);
    now += 3 * 60 * 1000 + 1;
    expect(indexer.health().boost_active).toBe(false);
    // Once it has ended, the next poke starts a new window.
    expect(indexer.poke()).toBe(now + 5 * 60 * 1000);
  });

  it("pokes into one-minute polling for five minutes and expires", () => {
    let now = 1_000_000;
    const indexer = new Indexer({
      source: new FakeSource(loadBlocks()),
      store: memoryStore(),
      logger: silentLogger(),
      now: () => now,
    });
    expect(indexer.health()).toMatchObject({ from: null, caught_up: null });
    expect(indexer.health().boost_active).toBe(false);
    const until = indexer.poke();
    expect(until).toBe(now + 5 * 60 * 1000);
    expect(indexer.health().boost_active).toBe(true);
    now += 5 * 60 * 1000 + 1;
    expect(indexer.health().boost_active).toBe(false);
  });
});

describe("indexer from", () => {
  it("reports INDEXER_FROM and caught_up", () => {
    const indexer = new Indexer({
      source: new FakeSource([]),
      store: memoryStore(),
      logger: silentLogger(),
      from: "2026-11-13T00:00:00.000Z",
    });
    expect(indexer.health()).toMatchObject({
      from: "2026-11-13T00:00:00.000Z",
      caught_up: null,
    });
  });
});

describe("indexer ingestion", () => {
  it("ingests final blocks, advances the cursor and emits each indexed event once", async () => {
    const f = fixture();
    const result = await f.indexer.syncOnce();

    expect(result).toMatchObject({ latest_block: 103, blocks: 4, events: 10, pages: 1 });
    expect(f.store.cursor()).toMatchObject({
      height: 103,
      blockHash: "BlockHash103",
      sourceCursor: "h:103",
    });
    expect(f.sink.events).toHaveLength(10);
    expect(f.store.health()).toMatchObject({
      events: 10,
      claims: 1,
      bookings: 1,
      quotes: 1,
      acks: 1,
      transfers: 1,
    });
  });

  it("is idempotent on re-ingestion and does not re-emit webhooks", async () => {
    const f = fixture();
    await f.indexer.syncOnce();
    const again = await f.indexer.syncOnce();
    expect(again.events).toBe(0);
    expect(f.sink.events).toHaveLength(10);
    expect(f.store.ingestBlock(f.blocks[1] as never)).toHaveLength(0);
    expect(f.store.health().bookings).toBe(1);
  });

  it("resumes from the stored cursor after a restart", async () => {
    const f = fixture();
    f.source.setHead(101);
    await f.indexer.syncOnce();
    expect(f.store.cursor()?.height).toBe(101);

    const resumed = new Indexer({
      source: f.source,
      store: f.store,
      sink: f.sink,
      maxPagesPerSync: 10,
      logger: silentLogger(),
    });
    f.source.setHead(103);
    const result = await resumed.syncOnce();
    expect(result.blocks).toBe(2);
    expect(f.store.cursor()?.height).toBe(103);
    expect(f.sink.events).toHaveLength(10);
  });

  it("does not process a block above the final head", async () => {
    const f = fixture();
    f.source.setHead(100);
    await f.indexer.syncOnce();
    expect(f.store.cursor()?.height).toBe(100);
    expect(f.sink.events).toHaveLength(3);
  });

  it("keeps ingesting when the webhook sink is down", async () => {
    const blocks = loadBlocks();
    const store = memoryStore();
    const sink = new RecordingSink(true);
    const indexer = new Indexer({
      source: new FakeSource(blocks),
      store,
      sink,
      maxPagesPerSync: 10,
      logger: silentLogger(),
    });
    await indexer.syncOnce();
    expect(store.health().events).toBe(10);
    expect(sink.events).toHaveLength(0);
  });

  it("projects claims, quotes, the booking and the transfer", async () => {
    const f = fixture();
    await f.indexer.syncOnce();
    const rows = f.store.statementRows(0, 2_000_000_000, "c-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      token_id: "c-1",
      owner_id: "buyer.near",
      amount_due: "12500000",
      booked_total: 12500000n,
      fee_total: 31250n,
      distributed_total: 12468750n,
      surplus: 0n,
      credit_total: 0n,
    });
  });

  it("prunes transient events but never evidence", async () => {
    const f = fixture();
    await f.indexer.syncOnce();
    expect(f.store.health().events).toBe(10);

    const deleted = f.store.pruneTransient(1793613721); // after block 102
    expect(deleted).toBe(1); // reconcile_failed
    expect(f.store.health().events).toBe(9);
    expect(f.store.receipt("TxPay1")).not.toBeNull();
    expect(f.store.eventsAfter(0, 100).some((event) => event.event === "reconcile_failed")).toBe(
      false,
    );
    expect(f.store.eventsAfter(0, 100).some((event) => event.event === "booked")).toBe(true);
  });
});

describe("indexer receipts", () => {
  it("creates a receipt only from a booked event", async () => {
    const f = fixture({ enricher: false });
    await f.indexer.syncOnce();
    expect(f.store.receipt("TxPay1")).not.toBeNull();
    expect(f.store.receipt("TxIssue1")).toBeNull();
    expect(f.store.receipt("TxAck1")).toBeNull();
  });

  it("enriches the booked receipt with origin and NEAR hashes", async () => {
    const f = fixture();
    await f.indexer.syncOnce();
    const receipt = f.store.receipt("TxPay1");
    expect(receipt).not.toBeNull();
    expect(receipt?.payment).toBe("12500000");
    expect(receipt?.asset).toContain("nep141:");
    expect(receipt?.terms_hash).toBe("0x" + "aa".repeat(32));
    expect(receipt?.verified).toBe(1);
    expect(receipt?.origin_json).toContain("0x" + "cc".repeat(32));
    expect(receipt?.near_hashes_json).toContain("NearHash1");
    expect(f.enricher?.calls).toBe(1);
  });

  it("keeps the booked receipt when enrichment fails", async () => {
    const blocks = loadBlocks();
    const store = memoryStore();
    const failing = {
      async enrich(): Promise<never> {
        throw new Error("provider down");
      },
    };
    const indexer = new Indexer({
      source: new FakeSource(blocks),
      store,
      enricher: failing,
      maxPagesPerSync: 10,
      logger: silentLogger(),
    });
    await indexer.syncOnce();
    const receipt = store.receipt("TxPay1");
    expect(receipt).not.toBeNull();
    expect(receipt?.origin_json).toBeNull();
    expect(receipt?.verified).toBe(0);
  });
});

describe("indexer fixture coverage", () => {
  it("ignores malformed logs and non-openrail standards", async () => {
    const f = fixture();
    await f.indexer.syncOnce();
    const events = f.store.eventsAfter(0, 100);
    expect(events).toHaveLength(10);
    expect(events.every((event) => event.event !== "ft_transfer")).toBe(true);
    expect(events.every((event) => event.block_hash.startsWith("BlockHash"))).toBe(true);
    expect(events.map((event) => event.event)).not.toContain("not-json");
    expect(ROOT).toBe("openrail.near");
  });
});
