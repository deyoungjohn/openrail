import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuoteProvider } from "./defaults.js";

// The first live quote failed with HTTP 400: 1Click now requires `dry` and `refundType`.
describe("the quote request sent to 1Click", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ONECLICK_API_URL;
    delete process.env.ONECLICK_JWT;
  });

  it("carries dry:false and refundType ORIGIN_CHAIN for a pay-page quote", async () => {
    process.env.ONECLICK_API_URL = "https://1click.example.test";
    process.env.ONECLICK_JWT = "jwt";
    let sent: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        sent = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ quote: { depositAddress: "0xdeposit", amountIn: "1", amountOut: "1" } }),
          {
            status: 200,
          },
        );
      }),
    );
    await createQuoteProvider().quote({
      originAsset: "nep141:base-usdc",
      destinationAsset: "nep141:usdc.near",
      amount: "3000000",
      swapType: "FLEX_INPUT",
      slippageTolerance: 0,
      refundTo: "0x12dcbbc7f96b87220e90b46d9528db156b1da841",
      recipient: "c-1.openrail.near",
      deadline: "2026-11-06T00:00:00Z",
    } as never);
    expect(sent).toMatchObject({
      dry: false,
      refundType: "ORIGIN_CHAIN",
      depositType: "ORIGIN_CHAIN",
      recipientType: "INTENTS",
    });
  });
});
