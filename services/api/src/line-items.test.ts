import { describe, expect, it } from "vitest";
import {
  PROCESSING_FEE_DESCRIPTION,
  lineItemsFingerprint,
  normalizeLineItems,
  processingFeeCents,
  resolveFee,
} from "./line-items.js";

describe("line items and fee mode", () => {
  it("rounds the fee up to whole cents", () => {
    const cases: Array<[string, string]> = [
      ["12.00", "0.03"],
      ["0.01", "0.01"],
      ["1000.00", "2.50"],
      ["33.33", "0.09"],
      ["400.00", "1.00"],
    ];
    for (const [subtotal, fee] of cases)
      expect(processingFeeCents(subtotal)).toBe(BigInt(fee.replace(".", "")));
  });

  it("keeps the contract net within one cent of the subtotal", () => {
    for (const subtotal of ["0.01", "4.00", "8.00", "12.00", "33.33", "400.00", "1000.00"]) {
      const fee = processingFeeCents(subtotal);
      const total = BigInt(subtotal.replace(".", "")) + fee;
      const paid = total * 10000n;
      const net = paid - (paid * 25n) / 10000n;
      const diff =
        net > BigInt(subtotal.replace(".", "")) * 10000n
          ? net - BigInt(subtotal.replace(".", "")) * 10000n
          : BigInt(subtotal.replace(".", "")) * 10000n - net;
      expect(diff < 10000n).toBe(true);
    }
  });

  it("appends a real fee line item only in pass_to_customer", () => {
    const base = normalizeLineItems([
      { description: "Work", quantity: 2, unit_amount_usd: "50.00" },
    ]);
    expect(base[0]?.amount_usd).toBe("100.00");
    const absorb = resolveFee("100.00", base, "absorb");
    expect(absorb.amountUsd).toBe("100.00");
    expect(absorb.items).toHaveLength(1);
    const pass = resolveFee("100.00", base, "pass_to_customer");
    expect(pass.amountUsd).toBe("100.25");
    expect(pass.items[1]).toEqual({
      description: PROCESSING_FEE_DESCRIPTION,
      quantity: 1,
      unit_amount_usd: "0.25",
      amount_usd: "0.25",
    });
    expect(lineItemsFingerprint(pass.items)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
