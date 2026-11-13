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

describe("checkout earnings from the real event shape", () => {
  it("reads the amount field the contract emits", async () => {
    const { dashClient } = await import("../../lib/client");
    vi.mocked(dashClient.events.list).mockImplementation((async ({ type }: { type: string }) => ({
      data:
        type === "checkout.paid"
          ? [
              {
                id: "e2",
                type,
                created: 1_762_768_800,
                // The fields of a real checkout_paid (13 Nov, reconcile CoBU42Ew...): amount, order_ref, surplus,
                // token_id, total_paid; the API adds booking_tx.
                data: {
                  token_id: "shop-1",
                  order_ref: "ORD-2",
                  amount: "3000000",
                  total_paid: "3000000",
                  surplus: "0",
                  booking_tx: "0xbooking2",
                },
              },
            ]
          : [],
      next_cursor: null,
    })) as never);
    const rows = await earningsSources[0]?.load();
    expect(rows?.[0]).toMatchObject({ cents: 300n, invoiceId: "shop-1", txHash: "0xbooking2" });
  });
});
