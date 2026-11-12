import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { appendOutcomeEvents, ensureEventTable } from "./event-log.js";

const BOOKED = `EVENT_JSON:${JSON.stringify({
  standard: "openrail",
  version: "1.0.0",
  event: "booked",
  data: [{ token_id: "c-1", payment: "100", asset: "USDC" }],
})}`;
const HELD = `EVENT_JSON:${JSON.stringify({
  standard: "openrail",
  version: "1.0.0",
  event: "settle_held",
  data: [{ token_id: "c-1", amount: "100" }],
})}`;

function outcome(logs: string[]) {
  return {
    transaction: { hash: "Tx1" },
    receipts_outcome: [{ id: "R1", outcome: { logs } }],
  };
}

describe("event log helper", () => {
  it("stores every EVENT_JSON log, not only booked", () => {
    const db = new DatabaseSync(":memory:");
    ensureEventTable(db);
    const written = appendOutcomeEvents(db, outcome([BOOKED, HELD]), {
      tokenId: "c-1",
      blockHeight: 10,
      timestamp: 1,
    });
    const rows = db
      .prepare("SELECT event, event_key FROM events ORDER BY event")
      .all() as unknown as { event: string; event_key: string }[];
    expect(written).toBe(2);
    expect(rows.map((row) => row.event)).toEqual(["booked", "settle_held"]);
    expect(rows[0]?.event_key).toBe("Tx1:R1:0:0:0");
    expect(rows[1]?.event_key).toBe("Tx1:R1:1:0:0");
  });

  it("ignores a repeated outcome by the event key", () => {
    const db = new DatabaseSync(":memory:");
    ensureEventTable(db);
    appendOutcomeEvents(db, outcome([BOOKED]), { tokenId: "c-1", blockHeight: 10, timestamp: 1 });
    appendOutcomeEvents(db, outcome([BOOKED]), { tokenId: "c-1", blockHeight: 10, timestamp: 1 });
    const count = db.prepare("SELECT COUNT(*) AS n FROM events").get() as unknown as { n: number };
    expect(count.n).toBe(1);
  });
});
