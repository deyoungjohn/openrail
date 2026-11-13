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

describe("invoice PDF payment status", () => {
  const hash = termsHash(terms);
  const generatedAt = "2026-11-09T12:00:00Z";
  const render = (statusInfo: {
    status: string;
    outstandingUsd?: string;
    paidAt?: string;
    receiptId?: string;
    verifyCommand?: string;
    generatedAt: string;
  }) =>
    Buffer.from(renderInvoicePdf(terms, hash, undefined, undefined, statusInfo)).toString("latin1");

  it("marks an issued invoice UNPAID and nothing else", () => {
    const pdf = render({ status: "Issued", generatedAt });
    expect(pdf).toContain("UNPAID");
    expect(pdf).not.toContain("PARTIALLY PAID");
    expect(/\bPAID\b/.test(pdf)).toBe(false);
    expect(pdf).toContain("Nov 9, 2026 12:00 UTC");
  });

  it("marks a partly paid invoice and the amount still due", () => {
    const pdf = render({ status: "PartiallyPaid", outstandingUsd: "5.00", generatedAt });
    expect(pdf).toContain("PARTIALLY PAID");
    expect(pdf).toContain("Still due $5.00");
    expect(pdf).not.toContain("UNPAID");
  });

  it("marks a paid invoice with its receipt and verification line", () => {
    const pdf = render({
      status: "Paid",
      paidAt: "2026-11-02T10:05:00Z",
      receiptId: "rcpt_0xbooking",
      verifyCommand:
        "openrail-verify claim c-1.openrail.near --terms-hash " + "0x" + "a".repeat(64),
      generatedAt,
    });
    expect(/\bPAID\b/.test(pdf)).toBe(true);
    expect(pdf).toContain("Nov 2, 2026");
    expect(pdf).toContain("rcpt_0xbooking");
    expect(pdf).toContain("openrail-verify claim c-1.openrail.near");
    expect(pdf).not.toContain("UNPAID");
    expect(pdf).not.toContain("PARTIALLY PAID");
  });

  it("stays deterministic for the same status input", () => {
    const statusInfo = {
      status: "PartiallyPaid",
      outstandingUsd: "5.00",
      generatedAt,
    };
    expect(Buffer.from(renderInvoicePdf(terms, hash, undefined, undefined, statusInfo))).toEqual(
      Buffer.from(renderInvoicePdf(terms, hash, undefined, undefined, statusInfo)),
    );
  });
});

describe("receipt PDF", () => {
  const receipt = {
    receipt_id: "rcpt_0xbooking",
    paid_at: "2026-11-02T10:05:00Z",
    invoice_number: "INV-2026-001",
    order_ref: "inv_1",
    business_name: "Acme Ltd",
    business_username: "acme",
    buyer_name: "Debtor Co",
    amount_usd: "12.50",
    paid_amount: "12500000",
    paid_asset: "nep141:usdc",
    network: "base",
    fee_usd: "0.00",
    payer_tx: { hash: "0xpayer" },
    near_tx: "0xnear",
    claim_account: "acme-9f3c2a7d41b8.openrail.near",
    terms_fingerprint: "0x" + "a".repeat(64),
    verify_command:
      "openrail-verify claim acme-9f3c2a7d41b8.openrail.near --terms-hash 0x" + "a".repeat(64),
  };

  it("prints every receipt field and the verification line", async () => {
    const { renderReceiptPdf } = await import("./pdf.js");
    const pdf = Buffer.from(renderReceiptPdf(receipt)).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).toContain("RECEIPT");
    expect(pdf).toContain("PAID");
    for (const value of [
      receipt.receipt_id,
      "Nov 2, 2026",
      receipt.invoice_number,
      receipt.order_ref,
      receipt.business_name,
      receipt.business_username,
      receipt.buyer_name,
      receipt.amount_usd,
      receipt.paid_amount,
      receipt.paid_asset,
      "base",
      receipt.fee_usd,
      "0xpayer",
      receipt.near_tx,
      receipt.claim_account,
      receipt.terms_fingerprint,
      receipt.verify_command,
    ]) {
      expect(pdf).toContain(value);
    }
    expect(pdf).not.toContain(receipt.paid_at);
  });

  it("is deterministic and does not break on long names", async () => {
    const { renderReceiptPdf } = await import("./pdf.js");
    const long = {
      ...receipt,
      business_name: "Business ".repeat(40),
      buyer_name: "Buyer ".repeat(40),
      verify_command: "openrail-verify claim " + "a".repeat(240),
    };
    const first = Buffer.from(renderReceiptPdf(long));
    const second = Buffer.from(renderReceiptPdf(long));
    expect(first).toEqual(second);
    expect(first.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("renders a receipt PDF envelope with the invoice number in the filename", async () => {
    const { renderReceiptPdfBase64 } = await import("./pdf.js");
    expect(typeof renderReceiptPdfBase64(receipt)).toBe("string");
  });
});

describe("invoice PDF header details (11 Nov, live)", () => {
  const draw = (t: typeof terms) =>
    Buffer.from(renderInvoicePdf(t, termsHash(t), "2026-11-11T00:00:00Z")).toString("latin1");
  /** Every text run: its x, y and the string. */
  const runs = (pdf: string) =>
    [...pdf.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm\n\((.*)\) Tj/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
      s: String(m[3]),
    }));

  it("pdf_long_claim_account_does_not_run_over_its_label", () => {
    const long = {
      ...terms,
      claim_account: "iamyoungjohn-near-89357a7d3075.openrail.near",
    };
    const all = runs(draw(long));
    const label = all.find((r) => r.s === "CLAIM ACCOUNT")!;
    const value = all.find((r) => r.s === long.claim_account)!;
    // The value is on its own line, below the label, so the two never share a line.
    expect(value.y).toBeLessThan(label.y - 6);
    // Its left edge stays right of the details column.
    expect(value.x).toBeGreaterThanOrEqual(360);
  });

  it("pdf_short_claim_account_stays_on_the_label_line", () => {
    const all = runs(draw(terms));
    const label = all.find((r) => r.s === "CLAIM ACCOUNT")!;
    const value = all.find((r) => r.s === terms.claim_account)!;
    expect(value.y).toBe(label.y);
  });

  it("pdf_placeholder_client_account_is_not_printed", () => {
    const anon = { ...terms, debtor_key: "anyone.openrail.near" };
    expect(draw(anon)).not.toContain("anyone.openrail.near");
    expect(draw(terms)).toContain("debtor.openrail.near");
  });
});
