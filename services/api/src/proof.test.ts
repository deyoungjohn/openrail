import { describe, expect, it } from "vitest";
import { proofRows } from "./proof.js";

const ev = (type: string, created: number, data: Record<string, unknown>) => ({
  id: `${type}-${created}`,
  type,
  created,
  data,
});

describe("proof rows", () => {
  it("lists invoices from the raw events and checkouts from the module's, newest first", () => {
    const rows = proofRows(
      [
        ev("issue", 100, { token_id: "inv-1", amount_due: "12500000", tx_hash: "T1" }),
        ev("booked", 200, { token_id: "inv-1", payment: "12500000", tx_hash: "T2" }),
        ev("issue", 300, { token_id: "chk-1", amount_due: "40500000", tx_hash: "T3" }),
        ev("checkout.created", 300, { token_id: "chk-1", total_usd: "40.50", tx_hash: "T3" }),
        ev("booked", 400, { token_id: "chk-1", payment: "40500000", tx_hash: "T4" }),
        ev("checkout.paid", 400, { token_id: "chk-1", total_usd: "40.50", tx_hash: "T4" }),
      ],
      "openrail.near",
    );
    expect(rows.map((r) => [r.type, r.amount_usd, r.tx])).toEqual([
      ["Checkout paid", "40.50", "T4"],
      ["Checkout opened", "40.50", "T3"],
      ["Invoice payment booked", "12.50", "T2"],
      ["Invoice issued", "12.50", "T1"],
    ]);
    expect(rows[0]?.claim).toBe("chk-1.openrail.near");
  });

  it("leaves out events without a transaction or an amount, and other kinds", () => {
    const rows = proofRows(
      [
        ev("issue", 1, { token_id: "a", amount_due: "1000000" }),
        ev("booked", 2, { token_id: "a", tx_hash: "X" }),
        ev("distributed", 3, { token_id: "a", amount: "1000000", tx_hash: "Y" }),
      ],
      "openrail.near",
    );
    expect(rows).toEqual([]);
  });
});
