import { describe, expect, it } from "vitest";
import { WatcherStore } from "./store.js";

describe("watcher store", () => {
  it("a folder the service may not write to starts empty instead of stopping the watcher", () => {
    // /dev/null is a file, so a folder below it cannot be created (ENOTDIR).
    const store = new WatcherStore("/dev/null/openrail/watcher.sqlite");
    expect(store.load()).toEqual([]);
    store.close();
  });
});

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("watcher event recording", () => {
  it("records every EVENT_JSON log from the send outcome", () => {
    const dir = mkdtempSync(join(tmpdir(), "watcher-events-"));
    const path = join(dir, "watcher.sqlite");
    try {
      const store = new WatcherStore(path);
      const log = (event: string) =>
        `EVENT_JSON:${JSON.stringify({
          standard: "openrail",
          version: "1.0.0",
          event,
          data: [{ token_id: "c-1" }],
        })}`;
      store.recordOutcome(
        {
          transaction: { hash: "Tx1" },
          receipts_outcome: [{ id: "R1", outcome: { logs: [log("booked"), log("settle_held")] } }],
        },
        { tokenId: "c-1", blockHeight: 10, timestamp: 100 },
      );
      store.close();
      const db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare("SELECT event FROM events ORDER BY event").all() as unknown as {
        event: string;
      }[];
      expect(rows.map((row) => row.event)).toEqual(["booked", "settle_held"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
