import { describe, expect, it, vi } from "vitest";
import { earningsSources } from "./earnings";

vi.mock("../../lib/client", () => ({
  dashClient: {
    events: {
      list: vi.fn(async ({ type }: { type: string }) => ({
        data:
          type === "checkout.paid"
            ? [
                {
                  id: "e1",
                  type,
                  created: 1_762_768_800,
                  data: {
                    token_id: "c-1",
                    order_ref: "ORD-1",
                    booking_tx: "0xbooking",
                    received: "2000000",
                    asset: "nep141:base-usdc",
                  },
                },
              ]
            : [],
        next_cursor: null,
      })),
    },
  },
}));

describe("checkout earnings source", () => {
  it("turns a paid checkout into one receipt-linked row", async () => {
    const rows = await earningsSources[0]?.load();
    expect(rows).toEqual([
      expect.objectContaining({
        stream: "checkout",
        cents: 200n,
        product: "Checkout ORD-1",
        txHash: "0xbooking",
        invoiceId: "c-1",
      }),
    ]);
  });
});
