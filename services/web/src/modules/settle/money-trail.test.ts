import { describe, expect, it } from "vitest";
import {
  applyHeldState,
  buildTrail,
  trailTotals,
  withdrawalRows,
  type TrailEvent,
} from "./money-trail";

const ev = (type: string, created: number, data: Record<string, unknown>): TrailEvent => ({
  id: `${type}-${created}`,
  type,
  created,
  data,
});

describe("money trail", () => {
  it("follows a share from held to the private balance", () => {
    const rows = buildTrail([
      ev("settle_held", 100, { token_id: "c-1", index: 0, amount: "1995000" }),
      ev("settle_sent", 200, { token_id: "c-1", index: 0, amount_in: "1995000", payout_id: 1 }),
      ev("settle_settled", 300, { token_id: "c-1", index: 0, destination_tx: "AbC" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "private", amount: 1995000n, tx: "AbC", time: 300000 });
  });

  it("never moves a row back when events arrive out of order", () => {
    const rows = buildTrail([
      ev("settle_settled", 300, { token_id: "c-1", index: 0, destination_tx: "AbC" }),
      ev("settle_held", 100, { token_id: "c-1", index: 0, amount: "1000000" }),
    ]);
    expect(rows[0]).toMatchObject({ stage: "private", amount: 1000000n });
  });

  it("a refund is its own end state", () => {
    const rows = buildTrail([
      ev("settle_held", 1, { token_id: "c-2", index: 0, amount: "500000" }),
      ev("settle_refunded", 2, { token_id: "c-2", index: 0, amount: "500000" }),
    ]);
    expect(rows[0]).toMatchObject({ stage: "returned", amount: 500000n });
  });

  it("keeps separate shares of one claim apart and sorts newest first", () => {
    const rows = buildTrail([
      ev("settle_held", 10, { token_id: "c-3", index: 0, amount: "1" }),
      ev("settle_held", 20, { token_id: "c-3", index: 1, amount: "2" }),
      ev("settle_held", 5, { token_id: "c-4", index: 0, amount: "3" }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["c-3#1", "c-3#0", "c-4#0"]);
  });

  it("ignores events it does not know and rows without a token or index", () => {
    expect(
      buildTrail([
        ev("invoice.paid", 1, { token_id: "c-1" }),
        ev("settle_held", 2, { amount: "5" }),
      ]),
    ).toEqual([]);
  });

  it("totals the money by where it is", () => {
    const rows = buildTrail([
      ev("settle_held", 1, { token_id: "a", index: 0, amount: "100" }),
      ev("settle_held", 1, { token_id: "b", index: 0, amount: "200" }),
      ev("settle_settled", 2, { token_id: "b", index: 0, destination_tx: "x" }),
    ]);
    expect(trailTotals(rows)).toEqual({
      held: 100n,
      sending: 0n,
      private: 200n,
      returned: 0n,
      withdrawn: 0n,
    });
  });
});

describe("withdrawals in the trail", () => {
  it("lists each withdrawal with its explorer link and counts only the finished ones", () => {
    const rows = withdrawalRows([
      {
        deposit_address: "d1",
        amount: "1000000",
        destination_chain: "base",
        address: "0xabc",
        created_at: "2026-11-13T06:00:00.000Z",
        updated_at: "2026-11-13T06:01:00.000Z",
        status: "SUCCESS",
        destination_tx_hashes: ["0x00d4"],
        destination_explorer_urls: ["https://basescan.org/tx/0x00d4"],
      },
      {
        deposit_address: "d2",
        amount: "500000",
        destination_chain: "base",
        address: "0xabc",
        created_at: "2026-11-13T07:00:00.000Z",
        status: "PROCESSING",
        destination_tx_hashes: [],
        destination_explorer_urls: [],
      },
    ]);
    expect(rows[0]?.stage).toBe("withdrawn");
    expect(rows[0]?.withdrawal?.urls).toEqual(["https://basescan.org/tx/0x00d4"]);
    expect(trailTotals(rows).withdrawn).toBe(1000000n);
  });
});

describe("the contract's state over stale events", () => {
  it("shows a share whose payout finished as in the private balance", () => {
    const rows = buildTrail([
      {
        id: "e1",
        type: "settle_held",
        created: 1,
        data: { token_id: "c-9", index: 0, amount: "9974051" },
      },
      {
        id: "e2",
        type: "settle_held",
        created: 2,
        data: { token_id: "c-8", index: 0, amount: "1995000" },
      },
    ]);
    const next = applyHeldState(rows, [
      { token_id: "c-9", index: 0, state: "settled", tx: "NearTx" },
      { token_id: "c-8", index: 0, state: "held", tx: null },
    ]);
    expect(next.find((r) => r.tokenId === "c-9")).toMatchObject({ stage: "private", tx: "NearTx" });
    expect(next.find((r) => r.tokenId === "c-8")?.stage).toBe("held");
    expect(trailTotals(next)).toMatchObject({ private: 9974051n, held: 1995000n });
  });
});
