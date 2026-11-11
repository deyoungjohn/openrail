import { describe, expect, it } from "vitest";
import { buildTrail, trailTotals, type TrailEvent } from "./money-trail";

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
    expect(trailTotals(rows)).toEqual({ held: 100n, sending: 0n, private: 200n, returned: 0n });
  });
});
