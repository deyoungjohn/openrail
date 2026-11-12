import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WatcherViews } from "./gaps.js";
import { loadBlocks, memoryStore } from "./test-support.js";

function cached(path: string, tokenId: string, bookedTotal: string, lastQuoteAt = 200): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS watched_claims (
    token_id TEXT PRIMARY KEY, kind INTEGER, status TEXT, last_quote_at INTEGER,
    due_at INTEGER, last_view TEXT, decided INTEGER
  )`);
  db.prepare("INSERT OR REPLACE INTO watched_claims VALUES (?, 0, 'Issued', ?, 0, ?, 0)").run(
    tokenId,
    lastQuoteAt,
    JSON.stringify({ booked_total: bookedTotal }),
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
