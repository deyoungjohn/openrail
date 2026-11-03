import { describe, expect, it } from "vitest";
import { FallbackEventSource } from "./fallback.js";
import type { EventSource, SourcePage } from "./types.js";

const PAGE: SourcePage = { blocks: [], cursor: "h:101", done: true, latestBlock: 101 };

function fakeSource(behaviour: "ok" | "fail", feature: string): EventSource {
  return {
    async fetch() {
      if (behaviour === "fail") throw new Error("down");
      return PAGE;
    },
    callCounts() {
      return { [feature]: 1 };
    },
  };
}

describe("indexer source fallback", () => {
  it("uses the account source when it works", async () => {
    const fallback = new FallbackEventSource(fakeSource("ok", "nb"), fakeSource("ok", "rpc"));
    await expect(fallback.fetch(null)).resolves.toEqual(PAGE);
    expect(fallback.callCounts()).toEqual({ nb: 1, rpc: 1 });
  });

  it("falls back to the RPC scanner only when the account source fails", async () => {
    const fallback = new FallbackEventSource(fakeSource("fail", "nb"), fakeSource("ok", "rpc"));
    await expect(fallback.fetch(null)).resolves.toEqual(PAGE);
  });
});
