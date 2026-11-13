import { describe, expect, it } from "vitest";
import { apiModule } from "./index.js";
import type { ApiModuleContext } from "../../modules.js";

function context(
  held: Record<string, unknown[]>,
  payouts: Record<number, string>,
  words: Record<string, string>,
) {
  return {
    requireAuth: () => ({ kind: "session", accountId: "merchant.near", scopes: [] }),
    requireScope: () => undefined,
    view: async (method: string, args: { token_id?: string; payout_id?: number }) =>
      method === "settle_held"
        ? (held[args.token_id ?? ""] ?? [])
        : { deposit_address: payouts[args.payout_id ?? -1] ?? "" },
    providerStatus: async (address: string) =>
      words[address] === undefined
        ? undefined
        : { status: words[address] as string, nearTxHashes: ["NearTx1"] },
  } as unknown as ApiModuleContext;
}

const request = (ids: string) => ({
  method: "GET",
  path: "/v1/business/held/state",
  query: new URLSearchParams({ token_ids: ids }),
  headers: {},
});

describe("held share state (chain, then the provider for a payout still in flight)", () => {
  it("shows a share whose payout the provider finished as settled, even before the worker reports it", async () => {
    const ctx = context(
      {
        "c-1": [{ status: { InFlight: { payout_id: 4 } } }, { status: "Held" }],
        "c-2": [{ status: { Settled: { payout_id: 1, destination_tx: "Dest1" } } }],
      },
      { 4: "dep-4" },
      { "dep-4": "SUCCESS" },
    );
    const r = await apiModule.route?.(request("c-1,c-2") as never, ctx);
    expect(r?.body).toEqual({
      data: [
        { token_id: "c-1", index: 0, state: "settled", tx: "NearTx1" },
        { token_id: "c-1", index: 1, state: "held", tx: null },
        { token_id: "c-2", index: 0, state: "settled", tx: "Dest1" },
      ],
    });
  });

  it("keeps an in-flight payout on its way while the provider is still processing", async () => {
    const ctx = context(
      { "c-1": [{ status: { InFlight: { payout_id: 4 } } }] },
      { 4: "dep-4" },
      { "dep-4": "PROCESSING" },
    );
    const r = await apiModule.route?.(request("c-1") as never, ctx);
    expect((r?.body as { data: { state: string }[] }).data[0]?.state).toBe("sending");
  });
});
