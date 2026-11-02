import { describe, expect, it } from "vitest";
import {
  chipFor,
  claimRows,
  invoiceTotalCents,
  lineCents,
  outstandingUnits,
  parseCents,
  summarize,
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
      ["1", "1.0"],
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
  debtorType: "near",
  debtorKey: "northwind.near",
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
  it("checks the client's account by type", () => {
    expect(validateIssue(form({ debtorKey: "Not An Account" }), today).debtorKey).toBeTruthy();
    expect(
      validateIssue(form({ debtorType: "evm", debtorKey: "0x123" }), today).debtorKey,
    ).toBeTruthy();
    expect(
      validateIssue(
        form({ debtorType: "evm", debtorKey: "0x53C5D39A5828BaDf817E40f22d75d96D731f8239" }),
        today,
      ).debtorKey,
    ).toBeUndefined();
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
