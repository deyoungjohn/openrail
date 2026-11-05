import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadBlocks, memoryStore, ROOT } from "./test-support.js";

const log = (event: string, data: Record<string, unknown>): string =>
  `EVENT_JSON:${JSON.stringify({ standard: "openrail", version: "1.0.0", event, data: [data] })}`;

describe("analytics", () => {
  it("counts a claim as paid only when cumulative booking reaches the amount due", () => {
    const store = memoryStore();
    const base = 1_793_613_600;
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
              token_id: "c-2",
              kind: 0,
              issuer_id: "acme.near",
              owner_id: "acme.near",
              debtor: { Near: "client.near" },
              terms_hash: "0x" + "a".repeat(64),
              amount_due: "100",
              due_date: base + 3 * 86_400,
            }),
          ],
        },
      ],
    });
    store.ingestBlock({
      height: 2,
      hash: "h2",
      timestamp: (base + 86_400) * 1_000_000_000,
      receipts: [
        {
          receiptId: "r2",
          txHash: "tx2",
          predecessorId: "",
          receiverId: ROOT,
          logs: [
            log("booked", {
              token_id: "c-2",
              payment: "40",
              surplus: "0",
              fee: "0",
              credit: "0",
              legs: [],
            }),
          ],
        },
      ],
    });
    expect(store.analytics().sample.paid).toBe(0);

    store.ingestBlock({
      height: 3,
      hash: "h3",
      timestamp: (base + 2 * 86_400) * 1_000_000_000,
      receipts: [
        {
          receiptId: "r3",
          txHash: "tx3",
          predecessorId: "",
          receiverId: ROOT,
          logs: [
            log("booked", {
              token_id: "c-2",
              payment: "60",
              surplus: "0",
              fee: "0",
              credit: "0",
              legs: [],
            }),
          ],
        },
      ],
    });
    const analytics = store.analytics();
    expect(analytics.sample).toMatchObject({ paid: 1, on_time: 1 });
    expect(analytics.average_days_to_paid).toBe(2);
    expect(analytics.payments_by_asset[0]).toMatchObject({ count: 2, amount: "100" });
  });

  it("equals the fixture computation", () => {
    const store = memoryStore();
    const events = loadBlocks().flatMap((block) => store.ingestBlock(block));
    const booked = events.find((event) => event.event === "booked");
    if (booked === undefined) throw new Error("missing booked event");
    store.updateReceiptEvidence(booked.eventKey, {
      origin_tx: {
        chain: "base",
        hash: "0x" + "cc".repeat(32),
        sender: "0x" + "ee".repeat(20),
        amount: "12500000",
      },
      near_tx_hashes: ["NearHash1"],
      verified: true,
    });
    const expected = JSON.parse(
      readFileSync(new URL("./fixtures/analytics-expected.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(store.analytics()).toEqual(expected);
  });
});
