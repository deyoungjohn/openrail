import { describe, expect, it } from "vitest";
import type { Earning } from "./earnings";
import { figures, flowSteps, monthBars, tokenLabel, type CashoutRow } from "./cashout";

const row = (over: Partial<CashoutRow> = {}): CashoutRow => ({
  id: "co_1",
  amount: "2000000",
  amount_out: "1997600",
  source_asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  destination_chain: "base",
  destination_address: "0x" + "e".repeat(40),
  route_cost_usd: "0.01",
  created_at: "2026-11-09T12:00:00Z",
  deadline: "2026-11-12T12:00:00Z",
  tx_hash: null,
  tx_state: null,
  status: "success",
  provider_status: null,
  near_tx_hashes: [],
  destination_tx_hashes: [],
  ...over,
});

const earning = (cents: bigint, iso: string): Earning => ({
  id: iso,
  time: Date.parse(iso),
  cents,
  payer: "x",
  product: "x",
  stream: "invoice",
  chain: "base",
  txHash: "0x",
  invoiceId: "inv",
});

describe("token label", () => {
  it("is the network and USDC, uppercase, with no brackets", () => {
    expect(tokenLabel("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near")).toBe(
      "BASE USDC",
    );
    expect(tokenLabel("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near")).toBe(
      "ARB USDC",
    );
    expect(
      tokenLabel("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
    ).toBe("NEAR USDC");
  });
});

describe("where the money is", () => {
  it("walks from the balance to the other network", () => {
    const at = (status: string, tx_state: string | null = null) =>
      flowSteps({ status, tx_state, tx_hash: tx_state ? "TX" : null }).map((s) => s.status);
    expect(at("quoted")).toEqual(["todo", "todo", "todo", "todo"]);
    expect(at("sent", "pending")).toEqual(["current", "todo", "todo", "todo"]);
    expect(at("sent", "success")).toEqual(["done", "current", "todo", "todo"]);
    expect(at("processing", "success")).toEqual(["done", "done", "current", "todo"]);
    expect(at("success", "success")).toEqual(["done", "done", "done", "done"]);
  });

  it("stops at the stop it never passed when it fails, is refunded or is short", () => {
    const at = (status: string, tx_state: string | null = null) =>
      flowSteps({ status, tx_state, tx_hash: "TX" }).map((s) => s.status);
    expect(at("incomplete", "success")).toEqual(["done", "failed", "todo", "todo"]);
    expect(at("refunded", "success")).toEqual(["done", "done", "failed", "todo"]);
    expect(at("failed", "failed")).toEqual(["failed", "todo", "todo", "todo"]);
  });
});

describe("cash-out against revenue", () => {
  const window = {
    from: Date.parse("2026-11-01T00:00:00Z"),
    to: Date.parse("2026-12-01T00:00:00Z"),
  };

  it("counts revenue and money taken out, and the rest is never negative", () => {
    const f = figures(
      [earning(1000n, "2026-11-02T00:00:00Z"), earning(500n, "2026-10-30T00:00:00Z")],
      [row({ amount: "4000000" })],
      window,
    );
    expect(f.revenueCents).toBe(1000n);
    expect(f.cashedOutCents).toBe(400n);
    expect(f.keptCents).toBe(600n);
    // More cashed out than earned in the window (money from an earlier month): zero, not a negative number.
    const g = figures(
      [earning(100n, "2026-11-02T00:00:00Z")],
      [row({ amount: "4000000" })],
      window,
    );
    expect(g.keptCents).toBe(0n);
  });

  it("does not count a cash-out that was refunded or failed", () => {
    const f = figures([], [row({ status: "refunded" }), row({ status: "failed" })], window);
    expect(f.cashedOutCents).toBe(0n);
  });

  it("makes six month bars, oldest first, never below zero", () => {
    const bars = monthBars(
      [earning(2500n, "2026-11-02T00:00:00Z"), earning(1000n, "2026-09-12T00:00:00Z")],
      [row({ amount: "10000000" })],
      Date.parse("2026-11-09T12:00:00Z"),
    );
    expect(bars.map((b) => b.month)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
    expect(bars[5]).toMatchObject({ label: "Nov", revenue: 25, cashedOut: 10 });
    expect(bars[3]).toMatchObject({ revenue: 10, cashedOut: 0 });
    expect(bars.every((b) => b.revenue >= 0 && b.cashedOut >= 0)).toBe(true);
  });
});
