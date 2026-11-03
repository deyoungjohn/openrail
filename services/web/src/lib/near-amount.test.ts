import { describe, expect, it } from "vitest";
import { formatNear, STORAGE_PER_INVOICE_YOCTO, storageCreditLow } from "./near-amount";

const NEAR = 10n ** 24n;

describe("formatNear: exact, from yoctoNEAR", () => {
  it("trims trailing zeros and keeps every other digit", () => {
    expect(formatNear(5n * NEAR)).toBe("5");
    expect(formatNear(NEAR / 50n)).toBe("0.02");
    expect(formatNear(NEAR + NEAR / 4n)).toBe("1.25");
    expect(formatNear(1n)).toBe("0.000000000000000000000001");
    expect(formatNear(0n)).toBe("0");
  });
  it("groups thousands", () => {
    expect(formatNear(1_234_567n * NEAR)).toBe("1,234,567");
  });
});

describe("storageCreditLow (blueprint 2.2: about 0.02 NEAR per invoice)", () => {
  it("is low when the balance cannot cover one invoice", () => {
    expect(STORAGE_PER_INVOICE_YOCTO).toBe(NEAR / 50n);
    expect(storageCreditLow(0n)).toBe(true);
    expect(storageCreditLow(NEAR / 50n - 1n)).toBe(true);
  });
  it("is fine from one invoice's worth up", () => {
    expect(storageCreditLow(NEAR / 50n)).toBe(false);
    expect(storageCreditLow(5n * NEAR)).toBe(false);
  });
});
