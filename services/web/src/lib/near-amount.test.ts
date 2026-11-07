import { describe, expect, it } from "vitest";
import {
  formatNear,
  MIN_DEPOSIT_YOCTO,
  parseNear,
  STORAGE_PER_INVOICE_YOCTO,
  storageCreditLow,
} from "./near-amount";

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

describe("parseNear", () => {
  it("reads plain decimals exactly", () => {
    expect(parseNear("1")).toBe(NEAR);
    expect(parseNear("0.02")).toBe(NEAR / 50n);
    expect(parseNear(".5")).toBe(NEAR / 2n);
    expect(parseNear(" 1,234.5 ")).toBe(1_234n * NEAR + NEAR / 2n);
    expect(parseNear("0.000000000000000000000001")).toBe(1n);
  });
  it("refuses anything else", () => {
    for (const bad of [
      "",
      ".",
      "abc",
      "-1",
      "1e3",
      "1.2.3",
      "0.0000000000000000000000001",
      "1 NEAR",
    ])
      expect(parseNear(bad)).toBeNull();
  });
  it("the minimum deposit is 0.02 NEAR", () => {
    expect(MIN_DEPOSIT_YOCTO).toBe(parseNear("0.02"));
  });
});
