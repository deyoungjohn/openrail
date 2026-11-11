import { describe, expect, it } from "vitest";
import { loadModuleEarnings } from "./use-earnings";
import type { Earning, EarningsSource } from "./earnings";

const row = (id: string, stream: "checkout" | "pay_link"): Earning => ({
  id,
  time: 1,
  cents: 200n,
  payer: "Anonymous",
  product: "Order",
  stream,
  chain: "base",
  txHash: "0xabc",
  invoiceId: "c-1",
});

describe("module earnings sources", () => {
  it("merges the sources and keeps a failing source out of the dashboard", async () => {
    const sources: EarningsSource[] = [
      { stream: "checkout", load: async () => [row("a", "checkout")] },
      {
        stream: "pay_link",
        load: async () => {
          throw new Error("source down");
        },
      },
    ];
    const result = await loadModuleEarnings(sources);
    expect(result.earnings.map((entry) => entry.id)).toEqual(["a"]);
    expect(result.failedStreams).toEqual(["pay_link"]);
  });
});
