import { describe, expect, it } from "vitest";
import { renderStatementPdf, type StatementDocument } from "./pdf.js";

function textOf(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  return [...raw.matchAll(/\((?:\\.|[^\\()])*\) Tj/g)]
    .map((match) => match[0].slice(1, -4).replace(/\\([()\\])/g, "$1"))
    .join("\n");
}

function pageCount(bytes: Uint8Array): number {
  return (
    Buffer.from(bytes)
      .toString("latin1")
      .match(/\/Type \/Page(?!s)/g) ?? []
  ).length;
}

function doc(overrides: Partial<StatementDocument> = {}): StatementDocument {
  return {
    businessName: "Belmonte Apparels",
    from: "2026-11-01",
    to: "2026-11-12",
    generatedAt: "2026-11-12T21:00:00Z",
    fingerprint: `0x${"ab".repeat(32)}`,
    payments: [
      { date: "2026-11-01T10:00:00Z", from: "INV-2026-001", amount: "12500001" },
      { date: "2026-11-02T10:00:00Z", from: "Checkout wc_order_7", amount: "2000000" },
    ],
    cashouts: [{ date: "2026-11-10T12:00:00Z", to: "0x1234...abcd", amount: "2000000" }],
    ...overrides,
  };
}

describe("statement PDF", () => {
  it("prints the business, rows, periods, totals and balance", () => {
    const text = textOf(renderStatementPdf(doc()));
    expect(text).toContain("Belmonte Apparels");
    expect(text).toContain("Payments");
    expect(text).toContain("received");
    expect(text).toContain("Statement, Nov 1 to Nov 12, 2026");
    expect(text).toContain("Nov 1, 2026");
    expect(text).toContain("INV-2026-001");
    expect(text).toContain("Checkout wc_order_7");
    expect(text).toContain("$12.500001");
    expect(text).toContain("Total received");
    expect(text).toContain("$14.500001");
    expect(text).toContain("Total cashed out");
    expect(text).toContain("$2.00");
    expect(text).toContain("Left in balance:");
    expect(text).toContain("$12.500001");
    expect(text).toContain("Powered by");
    expect(text).toContain("Amounts are USDC settled on NEAR.");
    expect(text).toContain(`Fingerprint: 0x${"ab".repeat(32)}`);
  });

  it("sums in integer base units, never rounding a sub-cent payment", () => {
    const text = textOf(
      renderStatementPdf(
        doc({
          payments: [
            { date: "2026-11-01T00:00:00Z", from: "A", amount: "1" },
            { date: "2026-11-01T01:00:00Z", from: "B", amount: "999999" },
          ],
          cashouts: [],
        }),
      ),
    );
    expect(text).toContain("$0.000001");
    expect(text).toContain("$0.999999");
    expect(text).toContain("$1.00");
    expect(text).toContain("Left in balance:");
    expect(text).toContain("$1.00");
  });

  it("paginates 120 rows with a repeated header and a footer on every page", () => {
    const payments = Array.from({ length: 120 }, (_, index) => ({
      date: "2026-11-01T00:00:00Z",
      from: `INV-${String(index + 1).padStart(3, "0")}`,
      amount: "100000",
    }));
    const bytes = renderStatementPdf(doc({ payments, cashouts: [] }));
    const raw = Buffer.from(bytes).toString("latin1");
    const pages = pageCount(bytes);
    expect(pages).toBeGreaterThan(1);
    expect((raw.match(/\(PAYMENTS\) Tj/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(raw.split("DATE \\(UTC\\)").length - 1).toBeGreaterThanOrEqual(2);
    expect((raw.match(/\(Powered by\) Tj/g) ?? []).length).toBe(pages);
    expect((raw.match(/\(Total received\) Tj/g) ?? []).length).toBe(1);
  });

  it("renders both tables and their empty lines for an empty period", () => {
    const text = textOf(renderStatementPdf(doc({ payments: [], cashouts: [] })));
    expect(text).toContain("PAYMENTS");
    expect(text).toContain("CASH-OUTS");
    expect((text.match(/None in this period/g) ?? []).length).toBe(2);
    expect(text).toContain("Total received");
    expect(text).toContain("$0.00");
    expect(text).toContain("Total cashed out");
    expect(text).toContain("$0.00");
  });

  it("cuts a very long business name with an ellipsis instead of overflowing", () => {
    const name = `Very long business name ${"x".repeat(200)}`;
    const bytes = renderStatementPdf(doc({ businessName: name }));
    const text = textOf(bytes);
    expect(text).toContain("...");
    expect(text).not.toContain(name);
    expect(
      (
        Buffer.from(bytes)
          .toString("latin1")
          .match(/\/Type \/Page(?!s)/g) ?? []
      ).length,
    ).toBe(1);
  });

  it("is byte-identical for identical input", () => {
    const input = doc();
    expect(Buffer.from(renderStatementPdf(input))).toEqual(Buffer.from(renderStatementPdf(input)));
  });
});
