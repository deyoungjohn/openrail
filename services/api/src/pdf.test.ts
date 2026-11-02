import { describe, expect, it } from "vitest";
import { renderInvoicePdf } from "./pdf.js";
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
