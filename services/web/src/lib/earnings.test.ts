import { describe, expect, it } from "vitest";
import {
  byChain,
  chainOfReceipt,
  byMonth,
  byStream,
  earningsFrom,
  inTimeRange,
  lastSevenDays,
  overview,
  revenueSummary,
  topPayers,
} from "./earnings";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const inv = [
  { id: "i1", invoice_number: "INV-1", debtor_legal_name: "Acme" },
  { id: "i2", invoice_number: "INV-2", debtor_legal_name: "Globex" },
];
const r = (id: string, invoice: string, amount: string, time: string, chain = "base") => ({
  id,
  invoice_id: invoice,
  amount,
  asset: "usdc",
  time,
  origin_tx: { chain, hash: "0x1", sender: "0xabcdef0123456789" },
  booking_tx_hash: `0x${id}`,
});
const receipts = {
  i1: [
    r("a", "i1", "3000000", "2026-11-14T10:00:00Z"),
    r("b", "i1", "1000000", "2026-10-20T10:00:00Z", "arbitrum"),
  ],
  i2: [r("c", "i2", "5000000", "2026-11-03T10:00:00Z")],
};
const e = earningsFrom(inv, receipts);

describe("earnings", () => {
  it("turns receipts into earnings, newest first, with the payer and what was paid for", () => {
    expect(e.map((x) => x.id)).toEqual(["a", "c", "b"]);
    expect(e[0]).toMatchObject({
      cents: 300n,
      payer: "Acme",
      product: "Invoice INV-1",
      stream: "invoice",
    });
  });
  it("sums this month against last month", () => {
    const s = revenueSummary(e, NOW);
    expect(s.currentCents).toBe(800n);
    expect(s.previousCents).toBe(100n);
    expect(s.deltaPct).toBe(700);
    expect(s.series).toHaveLength(8);
  });
  it("has no percent change when last month had nothing", () => {
    expect(revenueSummary([], NOW).deltaPct).toBeNull();
  });
  it("counts payments per day over the last seven days", () => {
    const d = lastSevenDays(e, NOW);
    expect(d).toHaveLength(7);
    expect(d[d.length - 2]?.count).toBe(1); // 14 Nov
  });
  it("compares the last 30 days with the 30 before", () => {
    const o = overview(e, NOW);
    expect(o.find((x) => x.key === "payments")?.value).toBe(3n);
    expect(o.find((x) => x.key === "received")?.value).toBe(900n);
  });
  it("ranks payers, and splits by stream, month and chain", () => {
    expect(topPayers(e)[0]).toEqual({ name: "Globex", cents: 500n });
    expect(byStream(e).find((x) => x.stream === "invoice")?.cents).toBe(900n);
    expect(byStream(e).find((x) => x.stream === "checkout")?.cents).toBe(0n);
    expect(byMonth(e).map((x) => x.month)).toEqual(["2026-10", "2026-11"]);
    expect(byChain(e)[0]).toMatchObject({ chain: "base", cents: 800n, count: 2 });
  });
  it("filters by time", () => {
    expect(inTimeRange(Date.parse("2026-11-14T10:00:00Z"), "7d", NOW)).toBe(true);
    expect(inTimeRange(Date.parse("2026-10-20T10:00:00Z"), "7d", NOW)).toBe(false);
    expect(inTimeRange(Date.parse("2026-10-20T10:00:00Z"), "all", NOW)).toBe(true);
  });
  it("never counts a payment with an unreadable time", () => {
    expect(earningsFrom(inv, { i1: [r("x", "i1", "1000000", "not a date")] })).toEqual([]);
  });
});

describe("chainOfReceipt", () => {
  it("reads the chain from the asset when the origin transaction is not verified yet", () => {
    const a = (asset: string) => chainOfReceipt({ asset, origin_tx: null });
    expect(a("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near")).toBe("base");
    expect(a("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near")).toBe("arbitrum");
    expect(a("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near")).toBe("solana");
    expect(a("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1")).toBe(
      "near",
    );
    expect(chainOfReceipt({ asset: "x", origin_tx: { chain: "polygon" } })).toBe("polygon");
  });
});
