import { describe, expect, it } from "vitest";
import { measureTextWidth, renderInvoicePdf, RIGHT_EDGE } from "./pdf.js";
import { buildTerms, termsHash } from "./terms.js";

const terms = buildTerms({
  invoice_number: "INV-2026-001",
  issuer_legal_name: "Acme Ltd",
  issuer_account: "acme.openrail.near",
  debtor_legal_name: "Debtor Co",
  debtor_key: "debtor.openrail.near",
  amount_usd: "12.50",
  due_date: "2026-12-01T00:00:00Z",
  line_items_sha256: "0x" + "b".repeat(64),
  claim_account: "c-1.openrail.near",
  pay_link: "https://pay.openrail.near/c-1",
});

describe("invoice PDF", () => {
  it("renders a valid PDF with the terms and hash", () => {
    const hash = termsHash(terms);
    const pdf = Buffer.from(renderInvoicePdf(terms, hash)).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("INV-2026-001");
    expect(pdf).toContain(hash);
    expect(pdf).toContain("Acme Ltd");
    expect(pdf).toContain("startxref");
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("escapes PDF metacharacters", () => {
    const tricky = { ...terms, invoice_number: "INV (1) \\ test" };
    const pdf = Buffer.from(renderInvoicePdf(tricky, termsHash(tricky))).toString("latin1");
    expect(pdf).toContain("INV \\(1\\) \\\\ test");
  });
});

describe("invoice PDF layout contract", () => {
  const hash = termsHash(terms);
  const content = () => Buffer.from(renderInvoicePdf(terms, hash)).toString("latin1");

  it("has the reference layout facts without third-party content", () => {
    const pdf = content();
    expect(pdf).toContain("/BaseFont /Helvetica");
    expect(pdf).toContain("/BaseFont /Helvetica-Bold");
    expect(pdf).toContain("/BaseFont /Times-Bold");
    expect(pdf).toContain("Invoice");
    expect(pdf).toContain("FROM");
    expect(pdf).toContain("BILLED TO");
    expect(pdf).toContain("DESCRIPTION");
    expect(pdf).toContain("AMOUNT");
    expect(pdf).toContain("TOTAL");
    expect(pdf).toContain("PAYMENT INSTRUCTIONS");
    expect(pdf).toContain("0.247 0.275 0.996 rg");
    expect(pdf).toContain("Tf");
    expect(
      Buffer.from(renderInvoicePdf(terms, hash, "2026-11-01T00:00:00Z")).toString("latin1"),
    ).toContain("ISSUE DATE");
  });

  it("does not print the line items hash (the page shows no line items, so it would be a number nobody can use)", () => {
    expect(content()).not.toContain(terms.line_items_sha256);
    expect(content()).not.toContain("Line items SHA-256");
  });

  it("prints the terms fields a reader needs and the terms hash", () => {
    const pdf = content();
    for (const value of [
      terms.issuer_legal_name,
      terms.issuer_account,
      terms.debtor_legal_name,
      terms.debtor_key,
      terms.amount_usd,
      "Dec 1, 2026",
      terms.claim_account,
      terms.pay_link,
      hash,
      ...terms.clauses,
    ]) {
      expect(pdf).toContain(value.replace(/[()\\]/g, (c) => `\\${c}`));
    }
  });

  it("formats dates in UTC without a locale lookup", () => {
    const pdf = content();
    expect(pdf).toContain("Dec 1, 2026");
    expect(pdf).not.toContain("2026-12-01T00:00:00Z");
    const withIssue = Buffer.from(renderInvoicePdf(terms, hash, "2026-11-01T00:00:00Z")).toString(
      "latin1",
    );
    expect(withIssue).toContain("Nov 1, 2026");
  });

  it("uses the invoice number as the table description and the terms amount as TOTAL", () => {
    const pdf = content();
    expect(pdf).toContain(terms.invoice_number);
    expect(pdf).toContain("$12.50");
    expect(pdf).not.toMatch(/\bHOURS\b|\bRATE\b|\bTAX\b|\bSUBTOTAL\b/);
  });

  it("is byte-for-byte deterministic for the same terms", () => {
    expect(Buffer.from(renderInvoicePdf(terms, hash))).toEqual(
      Buffer.from(renderInvoicePdf(terms, hash)),
    );
  });

  it("wraps long clauses and adds a page when needed", () => {
    const longClauses = Array.from(
      { length: 18 },
      (_, i) =>
        `Clause ${i + 1}: ${"This sentence repeats to force wrapping across a narrow page column. ".repeat(4)}`,
    );
    const longTerms = { ...terms, clauses: longClauses };
    const pdf = Buffer.from(renderInvoicePdf(longTerms, termsHash(longTerms))).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect((pdf.match(/\/Type \/Page(?!s)/g) ?? []).length).toBeGreaterThan(1);
    expect(pdf).toContain("Clause 18");
  });

  it("aligns every right edge to the rule and headings", () => {
    const pdf = Buffer.from(renderInvoicePdf(terms, hash, "2026-11-01T00:00:00Z")).toString(
      "latin1",
    );
    const fonts = new Map([
      ["Invoice", ["/F3", 30]],
      [terms.invoice_number, ["/F1", 9]],
      ["Nov 1, 2026", ["/F1", 9]],
      ["Dec 1, 2026", ["/F1", 9]],
      [terms.claim_account, ["/F1", 9]],
      ["$12.50", ["/F1", 9]],
    ] as const);
    for (const [value, [font, size]] of fonts) {
      const escaped = value
        .replace(/[()\\]/g, (c) => `\\${c}`)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(
        `/${font.slice(1)} ${size} Tf[\\s\\S]*?1 0 0 1 ([0-9.]+) [0-9.]+ Tm\\n\\(${escaped}\\) Tj`,
      ).exec(pdf);
      expect(match, `missing right-aligned text: ${value}`).not.toBeNull();
      const x = Number(match![1]);
      expect(Math.abs(x + measureTextWidth(font, value, size) - RIGHT_EDGE), value).toBeLessThan(
        0.02,
      );
    }
    for (const line of pdf.matchAll(/ (\d+\.\d+) (\d+\.\d+) m (\d+\.\d+) (\d+\.\d+) l S/g)) {
      if (Number(line[3]) > 100) expect(Number(line[3])).toBeCloseTo(RIGHT_EDGE, 2);
    }
  });

  it("does not overflow with long names or non-Latin text", () => {
    const tricky = {
      ...terms,
      issuer_legal_name: "A".repeat(180),
      debtor_legal_name: "債権者株式会社",
      clauses: ["条項: " + "長い文章".repeat(80)],
    };
    const pdf = Buffer.from(renderInvoicePdf(tricky, termsHash(tricky))).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).not.toContain("\u0000");
    expect(pdf).toContain("?".repeat(2));
  });
});

describe("invoice PDF line items", () => {
  const hash = termsHash(terms);
  const items = [
    {
      description: "Design and build the payment flow",
      quantity: 2,
      unit_amount_usd: "3.00",
      amount_usd: "6.00",
    },
    {
      description: "Review the invoice terms with the client",
      quantity: 1,
      unit_amount_usd: "6.50",
      amount_usd: "6.50",
    },
  ] as const;

  it("prints description, quantity, unit price and amount for every item", () => {
    const pdf = Buffer.from(renderInvoicePdf(terms, hash, undefined, items)).toString("latin1");
    expect(pdf).toContain("DESCRIPTION");
    expect(pdf).toContain("QUANTITY");
    expect(pdf).toContain("UNIT PRICE");
    expect(pdf).toContain("AMOUNT");
    for (const item of items) {
      expect(pdf).toContain(item.description);
      expect(pdf).toContain(`$${item.unit_amount_usd}`);
      expect(pdf).toContain(`$${item.amount_usd}`);
    }
  });

  it("uses the sum of the rows and leaves the line-items hash out", () => {
    const pdf = Buffer.from(renderInvoicePdf(terms, hash, undefined, items)).toString("latin1");
    expect(pdf).toContain("$12.50");
    expect(pdf).not.toContain(terms.line_items_sha256);
    expect(pdf).not.toContain("Line items SHA-256");
  });

  it("falls back to the one-row table when the items do not sum to the terms amount", () => {
    const mismatched = [{ ...items[0]!, amount_usd: "1.00" }];
    const pdf = Buffer.from(renderInvoicePdf(terms, hash, undefined, mismatched)).toString(
      "latin1",
    );
    expect(pdf).toContain(terms.invoice_number);
    expect(pdf).not.toContain(mismatched[0]!.description);
  });

  it("wraps long descriptions and paginates many rows", () => {
    const many = Array.from({ length: 45 }, (_, index) => ({
      description: `Row ${index + 1}: ${"A long description that must wrap inside the description column. ".repeat(3)}`,
      quantity: 1,
      unit_amount_usd: "0.01",
      amount_usd: "0.01",
    }));
    const manyTerms = { ...terms, amount_usd: "0.45" };
    const pdf = Buffer.from(
      renderInvoicePdf(manyTerms, termsHash(manyTerms), undefined, many),
    ).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect((pdf.match(/\/Type \/Page(?!s)/g) ?? []).length).toBeGreaterThan(1);
    expect(pdf).toContain("Row 45");
  });

  it("is deterministic with line items", () => {
    expect(Buffer.from(renderInvoicePdf(terms, hash, undefined, items))).toEqual(
      Buffer.from(renderInvoicePdf(terms, hash, undefined, items)),
    );
  });
});
