import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WatcherViews } from "./gaps.js";
import { FakeSource, loadBlocks, memoryStore, silentLogger } from "./test-support.js";
import { Indexer } from "./indexer.js";
import type { SourceBlock } from "./types.js";

function cached(
  path: string,
  tokenId: string,
  bookedTotal: string,
  lastQuoteAt = 200,
  claimAccount = "c-1.openrail.near",
): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS watched_claims (
    token_id TEXT PRIMARY KEY, kind INTEGER, status TEXT, last_quote_at INTEGER,
    due_at INTEGER, last_view TEXT, decided INTEGER
  )`);
  db.prepare("INSERT OR REPLACE INTO watched_claims VALUES (?, 0, 'Issued', ?, 0, ?, 0)").run(
    tokenId,
    lastQuoteAt,
    JSON.stringify({ booked_total: bookedTotal, claim_account: claimAccount }),
  );
  db.close();
}

describe("watcher gap detection", () => {
  it("reports a claim whose cached booked total is above the rows, then clears it", () => {
    const dir = mkdtempSync(join(tmpdir(), "gaps-"));
    const path = join(dir, "watcher.sqlite");
    try {
      const store = memoryStore();
      store.ingestBlock(loadBlocks()[1] as never);
      const token = "c-1";
      const seen = store.bookedTotal(token);
      cached(path, token, (seen + 1n).toString());
      const views = new WatcherViews(path);
      const since = new Map<string, number>();
      const gaps = views.gaps(store, 1_000_000, 0, since);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatchObject({ token_id: token, seen: seen.toString() });

      cached(path, token, seen.toString());
      expect(views.gaps(store, 1_000_000, 0, since)).toEqual([]);
      expect(since.has(token)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills the claim account once and clears the gap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaps-"));
    const path = join(dir, "watcher.sqlite");
    try {
      const log = `EVENT_JSON:${JSON.stringify({
        standard: "openrail",
        version: "1.0.0",
        event: "booked",
        data: [
          {
            token_id: "c-1",
            payment: "100",
            asset: "USDC",
            fee: "0",
            surplus: "0",
            credit: "0",
            legs: [],
          },
        ],
      })}`;
      const block: SourceBlock = {
        height: 10,
        hash: "Block10",
        timestamp: 100,
        receipts: [
          { receiptId: "R1", txHash: "BookTx", predecessorId: "", receiverId: "", logs: [log] },
        ],
      };
      cached(path, "c-1", "100");
      const store = memoryStore();
      const indexer = new Indexer({
        source: new FakeSource([]),
        store,
        watcherDbPath: path,
        logger: silentLogger(),
        gapSourceFactory: () => new FakeSource([block]),
      });
      expect(indexer.gaps()).toHaveLength(1);
      const filled = await indexer.sweepGaps();
      expect(filled).toBeGreaterThan(0);
      expect(indexer.gaps()).toEqual([]);
      expect(store.bookedTotal("c-1")).toBe(100n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores claims whose activity is before INDEXER_FROM", () => {
    const dir = mkdtempSync(join(tmpdir(), "gaps-"));
    const path = join(dir, "watcher.sqlite");
    try {
      const store = memoryStore();
      cached(path, "c-1", "99", 100);
      const views = new WatcherViews(path);
      expect(views.gaps(store, 1_000_000, 200, new Map())).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
