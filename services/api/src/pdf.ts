/**
 * Deterministic invoice PDF with the reference layout (no dependencies).
 *
 * The canonical terms stay the only source of money: the table shows the invoice number and
 * the USD amount from the terms, and TOTAL is that amount. Every terms field and the terms
 * hash are printed. Standard PDF fonts only (Helvetica/Helvetica-Bold/Times-Bold), no
 * embedding, and no clock or random value, so the same terms always produce the same bytes.
 */
import type { Terms } from "./terms.js";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 56;
const RIGHT = PAGE_WIDTH - MARGIN;
const WIDTH = RIGHT - MARGIN;
const ACCENT = "0.247 0.275 0.996";
const INK = "0.12 0.12 0.12";
const GRAY = "0.42 0.42 0.42";

type Font = "/F1" | "/F2" | "/F3" | "/F4";

interface PageBuilder {
  pages: string[];
  content: string;
  y: number;
}

function escapePdfText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** A deterministic approximation of the standard-font width; only layout depends on it. */
function textWidth(value: string, size: number): number {
  let units = 0;
  for (const char of value) {
    if ("il.,'!:;|".includes(char)) units += 0.28;
    else if ("mwMW@".includes(char)) units += 0.82;
    else if (char === " ") units += 0.27;
    else if (char >= "A" && char <= "Z") units += 0.64;
    else units += 0.52;
  }
  return units * size;
}

function wrapText(value: string, maxWidth: number, size: number): string[] {
  const words = value.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (textWidth(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line !== "") lines.push(line);
    if (textWidth(word, size) <= maxWidth) {
      line = word;
      continue;
    }
    let piece = "";
    for (const char of word) {
      if (textWidth(piece + char, size) > maxWidth && piece !== "") {
        lines.push(piece);
        piece = "";
      }
      piece += char;
    }
    line = piece;
  }
  if (line !== "") lines.push(line);
  return lines.length === 0 ? [""] : lines;
}

function beginPage(builder: PageBuilder, continuation: string | null): void {
  if (builder.content !== "") builder.pages.push(builder.content);
  builder.content = "";
  builder.y = PAGE_HEIGHT - MARGIN;
  if (continuation !== null) {
    text(builder, MARGIN, builder.y, 10, "/F2", GRAY, continuation, "left");
    builder.y -= 18;
  }
}

function finishPages(builder: PageBuilder): void {
  if (builder.content !== "") builder.pages.push(builder.content);
  builder.content = "";
}

function text(
  builder: PageBuilder,
  x: number,
  y: number,
  size: number,
  font: Font,
  color: string,
  value: string,
  align: "left" | "right" = "left",
): void {
  const escaped = escapePdfText(value);
  const startX = align === "right" ? x - textWidth(value, size) : x;
  builder.content += `BT\n${font} ${size} Tf\n${color} rg\n1 0 0 1 ${startX.toFixed(2)} ${y.toFixed(2)} Tm\n(${escaped}) Tj\nET\n`;
}

function line(
  builder: PageBuilder,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  color: string,
): void {
  builder.content += `${color} RG\n${width} w\n${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S\n`;
}

function label(builder: PageBuilder, value: string, x: number, y: number): void {
  text(builder, x, y, 7, "/F2", ACCENT, value.toUpperCase());
}

function wrapped(
  builder: PageBuilder,
  value: string,
  x: number,
  maxWidth: number,
  size: number,
  font: Font,
  color: string,
  lineHeight = size + 2,
): void {
  for (const part of wrapText(value, maxWidth, size)) {
    text(builder, x, builder.y, size, font, color, part);
    builder.y -= lineHeight;
  }
}

function drawClauses(builder: PageBuilder, terms: Terms, invoice: string): void {
  for (const clause of terms.clauses) {
    const lines = wrapText(`- ${clause}`, WIDTH, 7);
    for (const part of lines) {
      if (builder.y < MARGIN + 14) beginPage(builder, `Invoice ${invoice} (continued)`);
      text(builder, MARGIN, builder.y, 7, "/F1", GRAY, part);
      builder.y -= 9;
    }
    builder.y -= 2;
  }
}

function drawTop(builder: PageBuilder, terms: Terms, issuedAt?: string): void {
  const top = builder.y;
  text(builder, MARGIN, top, 8, "/F2", ACCENT, "FROM");
  text(builder, RIGHT, top + 4, 30, "/F3", INK, "Invoice", "right");
  text(builder, RIGHT, top - 16, 9, "/F1", GRAY, terms.invoice_number, "right");

  builder.y = top - 16;
  wrapped(builder, terms.issuer_legal_name, MARGIN, 250, 12, "/F2", INK);
  wrapped(builder, terms.issuer_account, MARGIN, 250, 9, "/F1", GRAY);

  builder.y = Math.min(builder.y, top - 70);
  line(builder, MARGIN, builder.y, RIGHT, builder.y, 0.8, ACCENT);
  line(builder, MARGIN, builder.y - 3, RIGHT, builder.y - 3, 0.8, ACCENT);
  builder.y -= 24;

  const blockTop = builder.y;
  label(builder, "BILLED TO", MARGIN, blockTop);
  builder.y = blockTop - 16;
  wrapped(builder, terms.debtor_legal_name, MARGIN, 240, 11, "/F2", INK);
  wrapped(builder, terms.debtor_key, MARGIN, 240, 9, "/F1", GRAY);

  const detailsX = 360;
  let detailY = blockTop;
  const details: Array<[string, string]> = [];
  const issueDate = issuedAt?.slice(0, 10);
  details.push([
    "ISSUE DATE",
    issueDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(issueDate) ? issueDate : "—",
  ]);
  details.push(["DUE DATE", terms.due_date], ["CLAIM ACCOUNT", terms.claim_account]);
  for (const [caption, value] of details) {
    label(builder, caption, detailsX, detailY);
    text(builder, RIGHT, detailY, 9, "/F1", INK, value, "right");
    detailY -= 16;
  }
  builder.y = Math.min(builder.y, detailY) - 8;
}

function drawTable(builder: PageBuilder, terms: Terms): void {
  builder.y = Math.min(builder.y, 470);
  const top = builder.y;
  label(builder, "DESCRIPTION", MARGIN, top);
  text(builder, RIGHT, top, 7, "/F2", ACCENT, "AMOUNT", "right");
  builder.y = top - 8;
  line(builder, MARGIN, builder.y, RIGHT, builder.y, 0.5, ACCENT);
  builder.y -= 18;

  const rows: Array<[string, string]> = [[terms.invoice_number, `$${terms.amount_usd}`]];
  if (terms.assignment_agreement_sha256 !== undefined) {
    rows.push(["Assignment agreement", "—"]);
  }
  for (const [description, amount] of rows) {
    text(builder, MARGIN, builder.y, 9, "/F1", INK, description);
    text(builder, RIGHT, builder.y, 9, "/F1", INK, amount, "right");
    builder.y -= 8;
    line(builder, MARGIN, builder.y, RIGHT, builder.y, 0.35, "0.82 0.82 0.82");
    builder.y -= 14;
  }
  builder.y -= 6;
}

function drawTotals(builder: PageBuilder, terms: Terms): void {
  const amount = `$${terms.amount_usd}`;
  builder.y -= 80;
  line(builder, 360, builder.y, RIGHT, builder.y, 1.2, ACCENT);
  builder.y -= 18;
  text(builder, 360, builder.y, 10, "/F2", INK, "TOTAL");
  text(builder, RIGHT, builder.y, 12, "/F2", ACCENT, amount, "right");
  builder.y -= 24;
}

function drawPayment(builder: PageBuilder, terms: Terms): void {
  builder.y = Math.min(builder.y - 20, 250);
  label(builder, "PAYMENT INSTRUCTIONS", MARGIN, builder.y);
  builder.y -= 16;
  wrapped(builder, terms.pay_link, MARGIN, WIDTH, 9, "/F1", INK);
  wrapped(builder, "Open the pay link above to pay.", MARGIN, WIDTH, 9, "/F1", GRAY);
  builder.y -= 6;
  label(builder, "THANK YOU FOR YOUR PAYMENT", MARGIN, builder.y);
  builder.y -= 24;
}

function drawTerms(builder: PageBuilder, terms: Terms, termsHash: string): void {
  const invoice = terms.invoice_number;
  builder.y = Math.min(builder.y, 180);
  if (builder.y < MARGIN + 90) beginPage(builder, `Invoice ${invoice} (continued)`);
  label(builder, "TERMS HASH", MARGIN, builder.y);
  builder.y -= 12;
  text(builder, MARGIN, builder.y, 7, "/F1", GRAY, termsHash);
  builder.y -= 12;
  text(
    builder,
    MARGIN,
    builder.y,
    7,
    "/F1",
    GRAY,
    `Line items SHA-256: ${terms.line_items_sha256}`,
  );
  builder.y -= 16;
  label(builder, "CLAUSES", MARGIN, builder.y);
  builder.y -= 12;
  drawClauses(builder, terms, invoice);
}

export function renderInvoicePdf(terms: Terms, termsHash: string, issuedAt?: string): Uint8Array {
  const builder: PageBuilder = { pages: [], content: "", y: PAGE_HEIGHT - MARGIN };
  beginPage(builder, null);
  drawTop(builder, terms, issuedAt);
  drawTable(builder, terms);
  drawTotals(builder, terms);
  drawPayment(builder, terms);
  drawTerms(builder, terms, termsHash);
  finishPages(builder);

  const pageIds = builder.pages.map((_, index) => 7 + index * 2);
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${builder.pages.length} >>`,
  );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>");
  builder.pages.forEach((content, index) => {
    const contentId = 8 + index * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
    );
  });

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

export function renderInvoicePdfBase64(terms: Terms, termsHash: string, issuedAt?: string): string {
  return Buffer.from(renderInvoicePdf(terms, termsHash, issuedAt)).toString("base64");
}
