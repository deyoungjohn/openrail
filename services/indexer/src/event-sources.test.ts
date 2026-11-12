import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOutcomeEvents, ensureEventTable } from "@openrail/shared";
import { describe, expect, it } from "vitest";
import { IndexerEventSource } from "./event-sources.js";
import { parseBlock } from "./parse.js";

const BOOKED = `EVENT_JSON:${JSON.stringify({
  standard: "openrail",
  version: "1.0.0",
  event: "booked",
  data: [{ token_id: "c-1", payment: "100", asset: "USDC" }],
})}`;

function write(path: string, hash: string): void {
  const db = new DatabaseSync(path);
  ensureEventTable(db);
  appendOutcomeEvents(
    db,
    {
      transaction: { hash },
      receipts_outcome: [{ id: "R1", outcome: { logs: [BOOKED] } }],
    },
    { tokenId: "c-1", blockHeight: 10, timestamp: 100 },
  );
  db.close();
}

describe("indexer event sources", () => {
  it("imports two files with independent cursors and keeps the scan event key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "events-"));
    try {
      const watcher = join(dir, "watcher.sqlite");
      const payout = join(dir, "payout.sqlite");
      write(watcher, "WatcherTx");
      write(payout, "PayoutTx");
      const source = new IndexerEventSource([watcher, payout]);
      const page = await source.fetch(null);
      const parsed = page.blocks.flatMap((block) => parseBlock(block));
      expect(parsed.map((event) => event.txHash).sort()).toEqual(["PayoutTx", "WatcherTx"]);
      expect(parsed.map((event) => event.eventKey).sort()).toEqual([
        "PayoutTx:R1:0:0:0",
        "WatcherTx:R1:0:0:0",
      ]);
      const next = await source.fetch(page.cursor);
      expect(next.blocks).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("50 booked payments need no scan or RPC call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "events-"));
    try {
      const watcher = join(dir, "watcher.sqlite");
      const db = new DatabaseSync(watcher);
      ensureEventTable(db);
      for (let n = 0; n < 50; n += 1) {
        appendOutcomeEvents(
          db,
          {
            transaction: { hash: `Tx${n}` },
            receipts_outcome: [{ id: "R1", outcome: { logs: [BOOKED] } }],
          },
          { tokenId: "c-1", blockHeight: 10, timestamp: 100 },
        );
      }
      db.close();
      const source = new IndexerEventSource([watcher]);
      const page = await source.fetch(null);
      expect(page.blocks).toHaveLength(1);
      expect(page.blocks[0]?.receipts).toHaveLength(50);
      expect(source.callCounts()).toEqual({ "event_sources.reads": 50 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing file is an empty source, not a crash", async () => {
    const source = new IndexerEventSource(["/definitely/not/here.sqlite"]);
    const page = await source.fetch(null);
    expect(page.blocks).toEqual([]);
    expect(page.done).toBe(true);
  });
});
