import { describe, expect, it } from "vitest";
import {
  amountPrefix,
  chainOfRoute,
  formatDueDate,
  formatToken,
  countdownUnits,
  payUnits,
  hashStrings,
  payStage,
  payTimeline,
  legAmountProblem,
  remainingCents,
  refundAddressProblem,
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
  it("maps the route names in fixtures/routes.json to badge ids", () => {
    for (const name of [
      "base",
      "arbitrum",
      "ethereum",
      "optimism",
      "polygon",
      "bnb",
      "solana",
      "near",
    ])
      expect(chainOfRoute(route({ origin_chain: name }))).toBe(name);
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

describe("formatDueDate", () => {
  it("formats an API date in UTC", () => {
    expect(formatDueDate("2026-12-01")).toBe("Dec 1, 2026");
  });
});

describe("refundAddressProblem (the API now requires refund_to, validated per chain)", () => {
  const evm = "0x53C5D39A5828BaDf817E40f22d75d96D731f8239";
  it("accepts a 0x address on every EVM chain", () => {
    for (const c of ["ethereum", "base", "arbitrum", "optimism", "polygon", "bnb"] as const)
      expect(refundAddressProblem(c, evm)).toBeNull();
  });
  it("refuses a short, long or non-hex EVM address", () => {
    expect(refundAddressProblem("base", "")).not.toBeNull();
    expect(refundAddressProblem("base", "0x123")).not.toBeNull();
    expect(refundAddressProblem("base", `${evm}0`)).not.toBeNull();
    expect(refundAddressProblem("base", `0x${"z".repeat(40)}`)).not.toBeNull();
  });
  it("accepts a Solana address and refuses an EVM one", () => {
    expect(
      refundAddressProblem("solana", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"),
    ).toBeNull();
    expect(refundAddressProblem("solana", evm)).not.toBeNull();
  });
  it("accepts NEAR named and implicit (64 hex) accounts", () => {
    expect(refundAddressProblem("near", "payer.near")).toBeNull();
    expect(refundAddressProblem("near", "a".repeat(64))).toBeNull();
    expect(refundAddressProblem("near", "Not An Account")).not.toBeNull();
  });
  it("never accepts a value when the chain has no rule", () => {
    expect(refundAddressProblem(null, evm)).not.toBeNull();
  });
});

describe("remainingCents: what is still to pay after the parts so far (H9)", () => {
  const leg = (
    cents: bigint,
    stage: "waiting" | "processing" | "paid" | "expired" | "refunded" | "failed",
  ) => ({
    cents,
    stage,
  });
  it("starts from the outstanding amount, rounded up to the cent", () => {
    expect(remainingCents("12500000", [])).toBe(1250n);
    expect(remainingCents("12500001", [])).toBe(1251n);
  });
  it("takes off every part that is waiting, arriving or paid", () => {
    expect(
      remainingCents("12500000", [
        leg(500n, "waiting"),
        leg(250n, "processing"),
        leg(100n, "paid"),
      ]),
    ).toBe(400n);
  });
  it("gives a part back when its price expired, it was refunded or it failed", () => {
    expect(
      remainingCents("12500000", [
        leg(500n, "expired"),
        leg(300n, "refunded"),
        leg(200n, "failed"),
        leg(250n, "paid"),
      ]),
    ).toBe(1000n);
  });
  it("never goes below zero", () => {
    expect(remainingCents("1000000", [leg(500n, "paid")])).toBe(0n);
  });
});

describe("legAmountProblem: the amount of one part", () => {
  it("accepts an amount up to what is left, with up to two decimals", () => {
    expect(legAmountProblem("5", 1250n)).toBeNull();
    expect(legAmountProblem("5.5", 1250n)).toBeNull();
    expect(legAmountProblem("12.50", 1250n)).toBeNull();
    expect(legAmountProblem("0.01", 1250n)).toBeNull();
  });
  it("refuses nothing, zero, words, and three decimals", () => {
    for (const v of ["", "0", "0.00", "abc", "1.234", "-1", "1e2"])
      expect(legAmountProblem(v, 1250n)).not.toBeNull();
  });
  it("refuses more than what is left and says how much is left", () => {
    const msg = legAmountProblem("12.51", 1250n);
    expect(msg).toContain("$12.50");
  });
  it("refuses any amount when nothing is left", () => {
    expect(legAmountProblem("1", 0n)).not.toBeNull();
  });
});

describe("hashStrings", () => {
  it("keeps plain hashes and unwraps provider objects, so nothing but text reaches the screen", () => {
    expect(hashStrings(["0xa", { hash: "0xb", explorerUrl: "" }, { nope: 1 }, null, ""])).toEqual([
      "0xa",
      "0xb",
    ]);
    expect(hashStrings(undefined)).toEqual([]);
  });
});

describe("payUnits for a stablecoin: two decimals, rounded UP", () => {
  it("BNB Chain USDT (18 decimals) is shown as cents, never as 18 digits, never below the price", () => {
    const price = "2008958170371703903"; // 2.008958170371703903
    const sent = payUnits(price, 18, "USDT");
    expect(sent).toBe("2010000000000000000");
    expect(formatToken(sent, 18)).toBe("2.01");
    expect(BigInt(sent)).toBeGreaterThanOrEqual(BigInt(price));
  });
  it("a price that is already whole cents is unchanged", () => {
    expect(payUnits("10010000", 6, "USDT")).toBe("10010000");
    expect(payUnits("10000000", 6, "USDC")).toBe("10000000");
  });
  it("a sub-cent price rounds up to the next cent", () => {
    expect(payUnits("10042765", 6, "USDT")).toBe("10050000");
  });
});

describe("payUnits", () => {
  it("rounds an ETH quote up to six decimals, so a wallet can enter it and it never falls short", () => {
    expect(payUnits("1348354311809600", 18, "ETH")).toBe("1349000000000000");
    expect(formatToken(payUnits("1348354311809600", 18, "ETH"), 18)).toBe("0.001349");
    expect(BigInt(payUnits("1348354311809600", 18, "ETH"))).toBeGreaterThanOrEqual(
      1348354311809600n,
    );
  });
  it("leaves an amount that is already round exactly as quoted; a stablecoin is rounded up to whole cents", () => {
    expect(payUnits("1349000000000000", 18, "ETH")).toBe("1349000000000000");
    expect(payUnits("3000000", 6, "USDC")).toBe("3000000");
    expect(payUnits("1234567", 6, "USDC")).toBe("1240000"); // $1.234567 -> $1.24, never below the price
  });
  it("rounds SOL up to five decimals", () => {
    expect(payUnits("11134668", 9, "SOL")).toBe("11140000");
  });
});

describe("countdownUnits", () => {
  it("adds hours when there is more than an hour left", () => {
    expect(countdownUnits(60 * 60_000)).toEqual(["hours", "minutes", "seconds"]);
    expect(countdownUnits(10 * 60_000)).toEqual(["minutes", "seconds"]);
    expect(countdownUnits(3 * 86_400_000)).toEqual(["days", "hours", "minutes"]);
  });
});
