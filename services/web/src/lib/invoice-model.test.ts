import { describe, expect, it } from "vitest";
import {
  chipFor,
  claimRows,
  invoiceTotalCents,
  lineCents,
  normalizePrice,
  outstandingUnits,
  parseCents,
  paymentsByChain,
  paymentsByMonth,
  summarize,
  typedNumber,
  validateIssue,
  type IssueForm,
} from "./invoice-model";

describe("parseCents", () => {
  it("reads API amounts exactly", () => {
    expect(parseCents("12.50")).toBe(1250n);
    expect(parseCents("0.05")).toBe(5n);
    expect(parseCents("1234567.89")).toBe(123456789n);
  });
  it("refuses anything that is not two decimals", () => {
    expect(parseCents("12.5")).toBeNull();
    expect(parseCents("12")).toBeNull();
    expect(parseCents("-1.00")).toBeNull();
    expect(parseCents("1e3")).toBeNull();
  });
});

describe("prices typed in the form", () => {
  it("accept whole numbers and one or two decimals", () => {
    expect(lineCents("2", "10")).toBe(2000n);
    expect(lineCents("1", "10.5")).toBe(1050n);
    expect(lineCents("1", "10.50")).toBe(1050n);
    expect(lineCents("3", "7")).toBe(2100n);
  });
  it("refuse zero, empty, signs, exponents and more than two decimals", () => {
    for (const u of ["", "0", "0.00", "00", "-1", "1e3", "1.234", ".5", "1.", "1,5", "abc"])
      expect(lineCents("1", u)).toBeNull();
  });
  it("normalise to two decimals for the API", () => {
    expect(normalizePrice("10")).toBe("10.00");
    expect(normalizePrice("10.5")).toBe("10.50");
    expect(normalizePrice("10.50")).toBe("10.50");
  });
  it("keep only digits and one dot while typing", () => {
    expect(typedNumber("1a0..5x", 2)).toBe("10.5");
    expect(typedNumber("12.345", 2)).toBe("12.34");
    expect(typedNumber("-5", 2)).toBe("5");
  });
});

describe("lineCents: quantity times unit price, never rounded", () => {
  it("multiplies whole and two-decimal quantities", () => {
    expect(lineCents("3", "10.00")).toBe(3000n);
    expect(lineCents("1.5", "10.00")).toBe(1500n);
    expect(lineCents("0.25", "10.00")).toBe(250n);
  });
  it("refuses a result with a fraction of a cent instead of rounding it", () => {
    expect(lineCents("0.5", "0.01")).toBeNull();
    expect(lineCents("0.33", "0.01")).toBeNull();
  });
  it("refuses empty, zero and malformed input", () => {
    for (const [q, u] of [
      ["", "1.00"],
      ["1", ""],
      ["0", "1.00"],
      ["1", "0.00"],
      ["abc", "1.00"],
      ["1.234", "1.00"],
    ] as const)
      expect(lineCents(q, u)).toBeNull();
  });
});

describe("invoiceTotalCents", () => {
  it("adds the lines exactly", () => {
    expect(
      invoiceTotalCents([
        { description: "A", quantity: "2", unit: "10.10" },
        { description: "B", quantity: "1", unit: "0.05" },
      ]),
    ).toBe(2025n);
  });
  it("is null when any line is invalid, so a wrong total is never shown", () => {
    expect(invoiceTotalCents([{ description: "A", quantity: "x", unit: "1.00" }])).toBeNull();
  });
});

const form = (over: Partial<IssueForm> = {}): IssueForm => ({
  invoiceNumber: "INV-0001",
  debtorName: "Northwind Studio",
  dueDate: "2026-12-01",
  lines: [{ description: "Design", quantity: "1", unit: "100.00" }],
  ...over,
});

describe("validateIssue", () => {
  const today = "2026-11-02";
  it("accepts a complete form", () => {
    expect(validateIssue(form(), today)).toEqual({});
  });
  it("needs a client name, a number and a due date after today", () => {
    expect(validateIssue(form({ debtorName: " " }), today).debtorName).toBeTruthy();
    expect(validateIssue(form({ invoiceNumber: "" }), today).invoiceNumber).toBeTruthy();
    expect(validateIssue(form({ dueDate: "2026-11-02" }), today).dueDate).toBeTruthy();
    expect(validateIssue(form({ dueDate: "" }), today).dueDate).toBeTruthy();
    expect(validateIssue(form({ dueDate: "2026-11-03" }), today).dueDate).toBeUndefined();
  });
  it("does not ask for the client's account or the chain they pay from", () => {
    // 9 Nov: nothing enforces it, and a merchant should not need to know it before creating an invoice.
    const e = validateIssue(form({}), today);
    expect(
      Object.keys(e).some((k) => k.startsWith("debtorKey") || k.startsWith("debtorType")),
    ).toBe(false);
  });
  it("needs at least one valid line, and says which one is wrong", () => {
    expect(validateIssue(form({ lines: [] }), today).lines).toBeTruthy();
    const e = validateIssue(
      form({
        lines: [
          { description: "ok", quantity: "1", unit: "1.00" },
          { description: "", quantity: "1", unit: "1.00" },
        ],
      }),
      today,
    );
    expect(e["line.1.description"]).toBeTruthy();
    expect(e["line.0.description"]).toBeUndefined();
    expect(
      validateIssue(form({ lines: [{ description: "x", quantity: "0.5", unit: "0.01" }] }), today)[
        "line.0.amount"
      ],
    ).toBeTruthy();
  });
});

const claim = {
  booked_total: "1000000",
  distributed_total: "997500",
  fee_total: "2500",
  surplus: "100000",
  credit_total: "50000",
  amount_due: "12500000",
};

describe("claim counters match claim() exactly", () => {
  it("outstanding = amount_due - (booked - surplus) - credit (blueprint 2.3)", () => {
    expect(outstandingUnits(claim)).toBe(12500000n - (1000000n - 100000n) - 50000n);
  });
  it("lists every counter with its exact USDC value", () => {
    const rows = claimRows(claim);
    expect(rows.map((r) => r.key)).toEqual([
      "amount_due",
      "booked_total",
      "distributed_total",
      "fee_total",
      "surplus",
      "credit_total",
      "outstanding",
    ]);
    expect(rows.find((r) => r.key === "fee_total")!.value).toBe(2500n);
  });
});

const inv = (over: Record<string, unknown> = {}) => ({
  status: "Issued" as const,
  due_date: "2026-12-01",
  debtor: { Near: "x.near" },
  ...over,
});
const NOW = Date.parse("2026-11-02T00:00:00Z") / 1000;

describe("chipFor (list view, from the invoice alone)", () => {
  it("maps statuses to the DESIGN.md chips", () => {
    expect(chipFor(inv(), NOW, false)).toEqual({ kind: "sent" });
    expect(chipFor(inv(), NOW, true)).toEqual({ kind: "acknowledged" });
    expect(chipFor(inv({ status: "Paid" }), NOW, true)).toEqual({ kind: "paid" });
    expect(chipFor(inv({ status: "Cancelled" }), NOW, false)).toEqual({ kind: "cancelled" });
    expect(chipFor(inv({ status: "Closed" }), NOW, false)).toEqual({ kind: "closed" });
    expect(chipFor(inv({ status: "PartiallyPaid" }), NOW, false)).toEqual({ kind: "partial" });
  });
  it("overdue is derived, with whole days", () => {
    expect(chipFor(inv({ due_date: "2026-10-30" }), NOW, false)).toEqual({
      kind: "overdue",
      days: 3,
    });
    expect(chipFor(inv({ status: "Paid", due_date: "2026-10-30" }), NOW, true)).toEqual({
      kind: "paid",
    });
  });
});

describe("summarize (dashboard)", () => {
  const list = [
    { ...inv(), amount_usd: "100.00", debtor_legal_name: "A Co" },
    { ...inv({ status: "Paid" }), amount_usd: "250.50", debtor_legal_name: "B Co" },
    { ...inv({ due_date: "2026-10-01" }), amount_usd: "40.00", debtor_legal_name: "A Co" },
    { ...inv({ status: "Cancelled" }), amount_usd: "999.00", debtor_legal_name: "C Co" },
  ];
  it("counts and totals exactly; cancelled invoices are in no total", () => {
    const s = summarize(list, NOW);
    expect(s.counts).toEqual({ all: 4, paid: 1, waiting: 1, overdue: 1 });
    expect(s.paidCents).toBe(25050n);
    expect(s.outstandingCents).toBe(14000n);
    expect(s.overdueCents).toBe(4000n);
  });
  it("ranks clients by what they have been invoiced, ties by name", () => {
    expect(summarize(list, NOW).topClients.map((c) => [c.name, c.totalCents])).toEqual([
      ["B Co", 25050n],
      ["A Co", 14000n],
    ]);
  });
  it("is all zero for an empty list", () => {
    expect(summarize([], NOW)).toMatchObject({
      counts: { all: 0 },
      paidCents: 0n,
      outstandingCents: 0n,
    });
  });
});

describe("summarize uses the API's outstanding and paid_total when it has them (SQ-10)", () => {
  const partly = {
    ...inv({ status: "PartiallyPaid", due_date: "2026-10-01" }),
    amount_usd: "100.00",
    debtor_legal_name: "A Co",
    outstanding: "40000000",
    paid_total: "60000000",
  };
  it("counts only what is still owed as outstanding and overdue, and what came in as collected", () => {
    const s = summarize([partly], NOW);
    expect(s.outstandingCents).toBe(4000n);
    expect(s.overdueCents).toBe(4000n);
    expect(s.paidCents).toBe(6000n);
    expect(s.counts).toEqual({ all: 1, paid: 0, waiting: 0, overdue: 1 });
  });
  it("rounds a sub-cent remainder up to the next cent", () => {
    const s = summarize([{ ...partly, outstanding: "40000001", paid_total: "59999999" }], NOW);
    expect(s.outstandingCents).toBe(4001n);
  });
  it("a paid invoice counts what was paid in", () => {
    const paid = {
      ...inv({ status: "Paid" }),
      amount_usd: "100.00",
      debtor_legal_name: "B Co",
      outstanding: "0",
      paid_total: "100000000",
    };
    expect(summarize([paid], NOW).paidCents).toBe(10000n);
  });
  it("without the fields it falls back to the invoice amount", () => {
    const old = { ...inv(), amount_usd: "100.00", debtor_legal_name: "C Co" };
    expect(summarize([old], NOW).outstandingCents).toBe(10000n);
  });
});

describe("payments by chain and by month (incoming only)", () => {
  const pay = (amount: string, chain: string, at: string, status = "success") => ({
    id: `${chain}${at}${amount}`,
    invoice_id: "i",
    amount,
    origin_chain: chain,
    origin_asset: "a",
    status,
    booked_at: at,
  });
  const list = [
    pay("10000000", "base", "2026-10-03T10:00:00Z"),
    pay("5000000", "base", "2026-11-01T00:00:00Z"),
    pay("2500000", "solana", "2026-11-02T10:00:00Z"),
    pay("9000000", "ethereum", "2026-11-02T10:00:00Z", "failed"),
    pay("1000000", "ethereum", "2026-11-02T10:00:00Z", "refunded"),
  ];
  it("sums settled payments per origin chain, largest first, ignoring refunded and failed ones", () => {
    expect(paymentsByChain(list)).toEqual([
      { chain: "base", units: 15000000n },
      { chain: "solana", units: 2500000n },
    ]);
  });
  it("sums settled payments per UTC month, oldest first", () => {
    expect(paymentsByMonth(list)).toEqual([
      { month: "2026-10", units: 10000000n },
      { month: "2026-11", units: 7500000n },
    ]);
  });
  it("is empty for no payments", () => {
    expect(paymentsByChain([])).toEqual([]);
    expect(paymentsByMonth([])).toEqual([]);
  });
});
