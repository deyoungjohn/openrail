import { describe, expect, it } from "vitest";
import { formatUsd, middleTruncate, usdParts } from "./format";

describe("formatUsd", () => {
  it("groups thousands and always shows two decimals", () => {
    expect(formatUsd(123456n)).toBe("$1,234.56");
    expect(formatUsd(5n)).toBe("$0.05");
    expect(formatUsd(0n)).toBe("$0.00");
  });

  it("never rounds: every cent survives, even above 2^53", () => {
    expect(formatUsd(9007199254740993n)).toBe("$90,071,992,547,409.93");
  });

  it("puts the minus sign before the dollar sign", () => {
    expect(formatUsd(-123456n)).toBe("-$1,234.56");
  });

  it("splits whole and cents for the KPI tile", () => {
    expect(usdParts(780050n)).toEqual({ whole: "$7,800", cents: "50" });
  });
});

describe("middleTruncate", () => {
  it("keeps head and tail with an ellipsis", () => {
    expect(
      middleTruncate("0x1bfc8f2d4e6a90b7c3d5e1f8a2b4c6d8e0f1a3b5c7d9e2f4a6b8c0d2e4f6a603"),
    ).toBe("0x1bfc…a603");
  });

  it("leaves short values alone", () => {
    expect(middleTruncate("alice.near")).toBe("alice.near");
  });
});
