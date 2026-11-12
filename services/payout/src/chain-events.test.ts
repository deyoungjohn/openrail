import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureEventTable } from "@openrail/shared";
import { PayoutChain } from "./chain.js";

const log = (event: string, data: Record<string, unknown>) =>
  `EVENT_JSON:${JSON.stringify({ standard: "openrail", version: "1.0.0", event, data: [data] })}`;

function fakeNear(logs: string[]) {
  return {
    sendFunctionCall: async () => ({
      status: { SuccessValue: Buffer.from("7").toString("base64") },
      transaction: { hash: "TxSettle" },
      transaction_outcome: { id: "TxSettle" },
      receipts_outcome: [{ id: "R1", outcome: { logs } }],
    }),
  } as never;
}

describe("the payout worker's own event file", () => {
  it("records every EVENT_JSON log of the transactions it sends, for the indexer", async () => {
    const db = new DatabaseSync(":memory:");
    ensureEventTable(db);
    const chain = new PayoutChain({
      rootAccount: "openrail.near",
      near: fakeNear([
        log("settle_sent", { token_id: "c-1", index: 0, payout_id: 7, amount_in: "1995000" }),
      ]),
      eventDb: db,
      now: () => 1_700_000_000_000,
    });
    await chain.settlePayout("c-1", 0, "deposit", "1995000");
    await chain.reportPayout("c-1", 0, 7, { Settled: { destination_tx: "NearTx" } });
    const rows = db.prepare("SELECT event, token_id, source FROM events").all() as {
      event: string;
      token_id: string;
      source: string;
    }[];
    expect(rows).toEqual([{ event: "settle_sent", token_id: "c-1", source: "payout" }]);
    expect(chain.eventWriteFailures).toBe(0);
  });

  it("a failing write is counted and never stops a payout", async () => {
    const db = new DatabaseSync(":memory:"); // no events table: every write fails
    const chain = new PayoutChain({
      rootAccount: "openrail.near",
      near: fakeNear([log("settle_sent", { token_id: "c-1", index: 0 })]),
      eventDb: db,
    });
    const out = await chain.settlePayout("c-1", 0, "deposit", "1");
    expect(out.payoutId).toBe(7);
    expect(chain.eventWriteFailures).toBeGreaterThan(0);
  });
});
