import { describe, expect, it, vi } from "vitest";
import { OneClickInPayout } from "./oneclick.js";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

describe("payout 1Click adapter", () => {
  it("builds a shield quote for a confidential destination", async () => {
    const quote = vi.fn(async () => ({
      quote: { amountIn: "2000000", amountOut: "2000000", depositAddress: "shield-deposit" },
    }));
    const adapter = new OneClickInPayout({ quote } as never);
    const result = await adapter.quote({
      asset: USDC,
      amount: "2000000",
      destination: { chain: "confidential", address: "merchant.near", min_amount: "1000000" },
      refundTo: "c-1.openrail.near",
      deadline: "2026-11-11T00:00:00.000Z",
    });
    expect(quote).toHaveBeenCalledWith(
      expect.objectContaining({
        originAsset: USDC,
        destinationAsset: USDC,
        amount: "2000000",
        swapType: "EXACT_INPUT",
        depositType: "INTENTS",
        recipientType: "CONFIDENTIAL_INTENTS",
        refundType: "INTENTS",
        recipient: "merchant.near",
        refundTo: "c-1.openrail.near",
      }),
    );
    expect(result).toMatchObject({ amountIn: "2000000", depositAddress: "shield-deposit" });
  });
});
