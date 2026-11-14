import { describe, expect, it } from "vitest";
import type { ProofRow } from "./proof-data";
import { proofStats } from "./proof-stats";

const row = (type: ProofRow["type"], amount: string, claim: string): ProofRow =>
  ({ type, amount_usd: amount, claim, tx: `${type}-${claim}`, time: 1 }) as ProofRow;

describe("proofStats", () => {
  it("adds up booked payments and counts each invoice or checkout once", () => {
    const s = proofStats([
      row("Invoice issued", "100.00", "a"),
      row("Invoice payment booked", "60.00", "a"),
      row("Invoice payment booked", "40.00", "a"),
      row("Checkout paid", "28.00", "b"),
      row("Late payment refunded", "5.00", "c"),
    ]);
    expect(s.processedUsd).toBe(128);
    expect(s.payments).toBe(3);
    expect(s.requests).toBe(2);
    expect(s.averageUsd).toBeCloseTo(42.67, 2);
  });
  it("is all zero with no rows", () => {
    expect(proofStats([])).toEqual({ processedUsd: 0, payments: 0, requests: 0, averageUsd: 0 });
  });
});
