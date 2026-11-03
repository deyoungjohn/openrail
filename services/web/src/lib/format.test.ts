import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatUsd,
  formatUsdc,
  formatUsdcExact,
  middleTruncate,
  usdParts,
} from "./format";

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

describe("formatUsdc rounds a sub-cent amount up to the next cent (summaries)", () => {
  it("leaves whole cents alone", () => {
    expect(formatUsdc(1_250_000_000n)).toBe("$1,250.00");
    expect(formatUsdc(10_000n)).toBe("$0.01");
    expect(formatUsdc(0n)).toBe("$0.00");
  });
  it("rounds any fraction of a cent up, never down", () => {
    expect(formatUsdc(1_000_137n)).toBe("$1.01");
    expect(formatUsdc(1n)).toBe("$0.01");
    expect(formatUsdc(9_999n)).toBe("$0.01");
    expect(formatUsdc(4_987_500n)).toBe("$4.99");
    expect(formatUsdc(12_500n)).toBe("$0.02");
  });
  it("rounds a negative amount away from zero too", () => {
    expect(formatUsdc(-1_000_137n)).toBe("-$1.01");
  });
});

describe("formatUsdcExact keeps every digit (what a person signs, and claim counters)", () => {
  it("shows whole cents as dollars and sub-cent USDC with all 6 decimals", () => {
    expect(formatUsdcExact(1_250_000_000n)).toBe("$1,250.00");
    expect(formatUsdcExact(1_000_137n)).toBe("$1.000137");
    expect(formatUsdcExact(4_987_500n)).toBe("$4.987500");
  });
});

describe("formatDate", () => {
  it("formats unix seconds in UTC", () => {
    expect(formatDate(1_800_086_400)).toBe("Jan 16, 2027");
  });
});
