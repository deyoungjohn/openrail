import { describe, expect, it } from "vitest";
import {
  amountPrefix,
  chainOfRoute,
  formatToken,
  payStage,
  payTimeline,
  spreadLabel,
  type RouteLike,
} from "./pay";

const route = (over: Partial<RouteLike> = {}): RouteLike => ({
  id: "R1",
  origin_chain: "base",
  payer_asset: "USDC",
  origin_decimals: 6,
  swap_type: "FLEX_INPUT",
  ...over,
});

describe("formatToken: exact, never rounded", () => {
  it("shows USDC with at least two decimals", () => {
    expect(formatToken("12500000", 6)).toBe("12.50");
    expect(formatToken("1000137", 6)).toBe("1.000137");
    expect(formatToken("0", 6)).toBe("0.00");
  });

  it("keeps every digit of an 18-decimals amount and trims trailing zeros", () => {
    expect(formatToken("3812345678901234000", 18)).toBe("3.812345678901234");
    expect(formatToken("12500000000000000000", 18)).toBe("12.50");
  });

  it("groups thousands in the whole part", () => {
    expect(formatToken("1234567890000", 6)).toBe("1,234,567.89");
  });

  it("handles SOL's 9 decimals", () => {
    expect(formatToken("84210526", 9)).toBe("0.084210526");
  });
});

describe("spreadLabel", () => {
  it("is the price-protection margin as a percent", () => {
    expect(spreadLabel(0)).toBe("0.00%");
    expect(spreadLabel(30)).toBe("0.30%");
    expect(spreadLabel(125)).toBe("1.25%");
  });
});

describe("amountPrefix (blueprint 2.8)", () => {
  it("USDC routes send exactly the amount due", () => {
    expect(amountPrefix(route())).toBe("exact");
  });
  it("ETH and SOL routes say 'you pay up to'", () => {
    expect(amountPrefix(route({ swap_type: "EXACT_OUTPUT", payer_asset: "ETH" }))).toBe("upto");
  });
});

describe("chainOfRoute", () => {
  it("maps API chain names to the badge ids", () => {
    expect(chainOfRoute(route({ origin_chain: "base" }))).toBe("base");
    expect(chainOfRoute(route({ origin_chain: "bnb" }))).toBe("bnb");
    expect(chainOfRoute(route({ origin_chain: "eth" }))).toBe("ethereum");
    expect(chainOfRoute(route({ origin_chain: "ethereum" }))).toBe("ethereum");
    expect(chainOfRoute(route({ origin_chain: "sol" }))).toBe("solana");
    expect(chainOfRoute(route({ origin_chain: "arb" }))).toBe("arbitrum");
    expect(chainOfRoute(route({ origin_chain: "op" }))).toBe("optimism");
    expect(chainOfRoute(route({ origin_chain: "pol" }))).toBe("polygon");
    expect(chainOfRoute(route({ origin_chain: "near" }))).toBe("near");
  });
  it("returns null for a chain the UI has no badge for, never a wrong one", () => {
    expect(chainOfRoute(route({ origin_chain: "unknownchain" }))).toBeNull();
  });
});

describe("payStage", () => {
  const now = Date.parse("2026-11-02T10:00:00Z");
  const future = "2026-11-02T10:30:00Z";
  const past = "2026-11-02T09:59:00Z";
  it("waits for the deposit until the deadline", () => {
    expect(payStage("pending_deposit", future, now)).toBe("waiting");
  });
  it("an expired quote is never reused", () => {
    expect(payStage("pending_deposit", past, now)).toBe("expired");
  });
  it("money already in flight keeps going after the deadline", () => {
    expect(payStage("processing", past, now)).toBe("processing");
    expect(payStage("success", past, now)).toBe("paid");
  });
  it("maps refunded and failed", () => {
    expect(payStage("refunded", future, now)).toBe("refunded");
    expect(payStage("failed", future, now)).toBe("failed");
  });
});

describe("payTimeline", () => {
  it("shows the three steps with the right current one", () => {
    expect(payTimeline("waiting").map((s) => s.status)).toEqual(["current", "todo", "todo"]);
    expect(payTimeline("processing").map((s) => s.status)).toEqual(["done", "current", "todo"]);
    expect(payTimeline("paid").map((s) => s.status)).toEqual(["done", "done", "done"]);
  });
  it("marks the step that failed", () => {
    expect(payTimeline("failed").map((s) => s.status)).toEqual(["done", "failed", "todo"]);
    expect(payTimeline("refunded").map((s) => s.status)).toEqual(["done", "failed", "todo"]);
  });
});
