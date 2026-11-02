/**
 * Deterministic one-page invoice PDF (no dependency). The PDF prints every
 * canonical terms field and the terms hash (blueprint 2.6).
 */
import type { Terms } from "./terms.js";

function escapePdfText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

export function renderInvoicePdf(terms: Terms, termsHash: string): Uint8Array {
  const lines = [
    "OPENRAIL INVOICE",
    "",
    `Invoice: ${terms.invoice_number}`,
    `Issuer: ${terms.issuer_legal_name} (${terms.issuer_account})`,
    `Debtor: ${terms.debtor_legal_name} (${terms.debtor_key})`,
    `Amount: USD ${terms.amount_usd}`,
    `Due: ${terms.due_date}`,
    `Claim account: ${terms.claim_account}`,
    `Pay link: ${terms.pay_link}`,
    `Terms hash: ${termsHash}`,
    "",
    ...terms.clauses.map((clause) => `- ${clause}`),
  ];
  const text = lines
    .map(
      (line, index) =>
        `${index === 0 ? "/F1 14 Tf " : "/F1 9 Tf "}0 ${760 - index * 18} Td (${escapePdfText(line)}) Tj`,
    )
    .join("\n");
  const content = `BT\n${text}\nET\n`;

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

export function renderInvoicePdfBase64(terms: Terms, termsHash: string): string {
  return Buffer.from(renderInvoicePdf(terms, termsHash)).toString("base64");
}
