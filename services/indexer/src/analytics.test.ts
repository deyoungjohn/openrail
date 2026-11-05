import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadBlocks, memoryStore } from "./test-support.js";

describe("analytics", () => {
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
