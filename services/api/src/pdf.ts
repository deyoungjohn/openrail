/**
 * Deterministic invoice PDF with the reference layout (no dependencies).
 *
 * The canonical terms stay the only source of money: the table shows the invoice number and
 * the USD amount from the terms, and TOTAL is that amount. Every terms field and the terms
 * hash are printed. Standard PDF fonts only (Helvetica/Helvetica-Bold/Times-Bold), no
 * embedding, and no clock or random value, so the same terms always produce the same bytes.
 */
import type { Terms } from "./terms.js";
import type { LineItem } from "./line-items.js";
import { WORDMARK_PATHS, WORDMARK_VIEWBOX } from "./statement-wordmark.js";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 56;
const RIGHT = PAGE_WIDTH - MARGIN;
const WIDTH = RIGHT - MARGIN;
export const RIGHT_EDGE = RIGHT;
const ACCENT = "0.247 0.275 0.996";
const INK = "0.12 0.12 0.12";
const GRAY = "0.42 0.42 0.42";

export type Font = "/F1" | "/F2" | "/F3" | "/F4";

export interface InvoiceStatusInfo {
  status: string;
  outstandingUsd?: string;
  paidAt?: string;
  receiptId?: string;
  verifyCommand?: string;
  generatedAt: string;
}

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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return "—";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "—";
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

function formatDateTime(iso: string): string {
  const date = formatDate(iso);
  const time = /T(\d{2}):(\d{2})/.exec(iso);
  if (date === "—" || time === null) return "—";
  return `${date} ${time[1]}:${time[2]} UTC`;
}

function statusMark(status: string): string {
  if (status === "Paid") return "PAID";
  if (status === "PartiallyPaid") return "PARTIALLY PAID";
  return "UNPAID";
}

// Adobe standard-font widths (per 1000 em) for the printable ASCII range. Keeping these
// lets right-aligned text end on the same x as the rules without embedding a font.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
const TIMES_BOLD = [
  250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500,
  500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500, 930, 722, 667, 722, 722, 667,
  611, 778, 778, 389, 500, 778, 667, 944, 722, 778, 611, 778, 722, 556, 667, 722, 722, 1000, 722,
  722, 667, 333, 278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556,
  278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
];

function glyphWidth(font: Font, char: string): number {
  const code = char.charCodeAt(0);
  if (code < 0x20 || code > 0x7e) return font === "/F3" ? 500 : 556;
  const index = code - 0x20;
  const table = font === "/F2" ? HELVETICA_BOLD : font === "/F3" ? TIMES_BOLD : HELVETICA;
  return table[index] ?? (font === "/F3" ? 500 : 556);
}

export function measureTextWidth(font: Font, value: string, size: number): number {
  let units = 0;
  for (const char of value) units += glyphWidth(font, char);
  return (units / 1000) * size;
}

function wrapText(value: string, maxWidth: number, size: number, font: Font = "/F1"): string[] {
  const words = value.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (measureTextWidth(font, candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line !== "") lines.push(line);
    if (measureTextWidth(font, word, size) <= maxWidth) {
      line = word;
      continue;
    }
    let piece = "";
    for (const char of word) {
      if (measureTextWidth(font, piece + char, size) > maxWidth && piece !== "") {
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
  const startX = align === "right" ? x - measureTextWidth(font, value, size) : x;
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
  for (const part of wrapText(value, maxWidth, size, font)) {
    text(builder, x, builder.y, size, font, color, part);
    builder.y -= lineHeight;
  }
}

function drawClauses(builder: PageBuilder, terms: Terms, invoice: string): void {
  for (const clause of terms.clauses) {
    const lines = wrapText(`- ${clause}`, WIDTH, 7, "/F1");
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
  // `anyone.<root>` stands in for "no client account was given" (the invoice form no longer asks for one): not an account.
  if (!/^anyone\./.test(terms.debtor_key))
    wrapped(builder, terms.debtor_key, MARGIN, 240, 9, "/F1", GRAY);

  const detailsX = 360;
  let detailY = blockTop;
  const details: Array<[string, string]> = [
    ["ISSUE DATE", issuedAt !== undefined ? formatDate(issuedAt) : "—"],
    ["DUE DATE", formatDate(terms.due_date)],
    ["CLAIM ACCOUNT", terms.claim_account],
  ];
  for (const [caption, value] of details) {
    label(builder, caption, detailsX, detailY);
    // A long value (the claim account) would run back over its own label: it goes on the line below, right-aligned.
    const room = RIGHT - detailsX - measureTextWidth("/F2", caption.toUpperCase(), 7) - 12;
    if (measureTextWidth("/F1", value, 9) > room) {
      detailY -= 13;
      text(builder, RIGHT, detailY, 8, "/F1", INK, value, "right");
    } else {
      text(builder, RIGHT, detailY, 9, "/F1", INK, value, "right");
    }
    detailY -= 16;
  }
  builder.y = Math.min(builder.y, detailY) - 8;
}

function usdCents(value: string): bigint | null {
  const match = /^(\d+)\.(\d{2})$/.exec(value);
  if (match === null) return null;
  return BigInt(match[1] ?? "0") * 100n + BigInt(match[2] ?? "0");
}

function lineItemsTotal(items: readonly LineItem[]): string | null {
  let cents = 0n;
  for (const item of items) {
    const amount = usdCents(item.amount_usd);
    if (amount === null) return null;
    cents += amount;
  }
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

const QTY_RIGHT = 388;
const UNIT_RIGHT = 468;

function drawTableHeader(builder: PageBuilder): void {
  const top = builder.y;
  label(builder, "DESCRIPTION", MARGIN, top);
  text(builder, QTY_RIGHT, top, 7, "/F2", ACCENT, "QUANTITY", "right");
  text(builder, UNIT_RIGHT, top, 7, "/F2", ACCENT, "UNIT PRICE", "right");
  text(builder, RIGHT, top, 7, "/F2", ACCENT, "AMOUNT", "right");
  builder.y = top - 8;
  line(builder, MARGIN, builder.y, RIGHT, builder.y, 0.5, ACCENT);
  builder.y -= 18;
}

function drawTable(builder: PageBuilder, terms: Terms, lineItems?: readonly LineItem[]): void {
  builder.y = builder.y - 40;
  drawTableHeader(builder);

  const items =
    lineItems !== undefined &&
    lineItems.length > 0 &&
    lineItemsTotal(lineItems) === terms.amount_usd
      ? lineItems
      : [];
  const rows: Array<{ description: string; quantity: string; unit: string; amount: string }> =
    items.length > 0
      ? items.map((item) => ({
          description: item.description,
          quantity: String(item.quantity),
          unit: `$${item.unit_amount_usd}`,
          amount: `$${item.amount_usd}`,
        }))
      : [
          {
            description: terms.invoice_number,
            quantity: "1",
            unit: "—",
            amount: `$${terms.amount_usd}`,
          },
        ];
  if (terms.assignment_agreement_sha256 !== undefined) {
    rows.push({ description: "Assignment agreement", quantity: "—", unit: "—", amount: "—" });
  }

  for (const row of rows) {
    const descriptionWidth = QTY_RIGHT - MARGIN - 16;
    const lines = wrapText(row.description, descriptionWidth, 9, "/F1");
    const rowHeight = Math.max(14, lines.length * 11 + 4);
    if (builder.y - rowHeight - 8 < MARGIN + 20) {
      beginPage(builder, `Invoice ${terms.invoice_number} (continued)`);
      drawTableHeader(builder);
    }
    const top = builder.y;
    lines.forEach((line, index) => {
      text(builder, MARGIN, top - index * 11, 9, "/F1", INK, line);
    });
    text(builder, QTY_RIGHT, top, 9, "/F1", INK, row.quantity, "right");
    text(builder, UNIT_RIGHT, top, 9, "/F1", INK, row.unit, "right");
    text(builder, RIGHT, top, 9, "/F1", INK, row.amount, "right");
    builder.y = top - rowHeight;
    line(builder, MARGIN, builder.y, RIGHT, builder.y, 0.35, "0.82 0.82 0.82");
    builder.y -= 6;
  }
  builder.y -= 4;
}

function drawTotals(builder: PageBuilder, terms: Terms, status?: InvoiceStatusInfo): void {
  const amount = `$${terms.amount_usd}`;
  if (status !== undefined) {
    text(builder, 360, builder.y, 9, "/F2", ACCENT, statusMark(status.status));
    text(
      builder,
      RIGHT,
      builder.y,
      7,
      "/F1",
      GRAY,
      `As of ${formatDateTime(status.generatedAt)}`,
      "right",
    );
    builder.y -= 12;
    if (status.status === "PartiallyPaid" && status.outstandingUsd !== undefined) {
      text(builder, 360, builder.y, 8, "/F1", INK, `Still due $${status.outstandingUsd}`);
      builder.y -= 12;
    }
    if (status.status === "Paid" && status.paidAt !== undefined) {
      text(builder, 360, builder.y, 8, "/F1", INK, `Paid ${formatDate(status.paidAt)}`);
      builder.y -= 12;
    }
  }
  builder.y -= 12;
  line(builder, 360, builder.y, RIGHT, builder.y, 1.2, ACCENT);
  builder.y -= 18;
  text(builder, 360, builder.y, 10, "/F2", INK, "TOTAL");
  text(builder, RIGHT, builder.y, 12, "/F2", ACCENT, amount, "right");
  builder.y -= 24;
}

function drawPayment(builder: PageBuilder, terms: Terms): void {
  builder.y = builder.y - 16;
  label(builder, "PAYMENT INSTRUCTIONS", MARGIN, builder.y);
  builder.y -= 16;
  wrapped(builder, terms.pay_link, MARGIN, WIDTH, 9, "/F1", INK);
  wrapped(builder, "Open the pay link above to pay.", MARGIN, WIDTH, 9, "/F1", GRAY);
  builder.y -= 6;
  label(builder, "THANK YOU FOR YOUR PAYMENT", MARGIN, builder.y);
  builder.y -= 24;
}

function drawTerms(
  builder: PageBuilder,
  terms: Terms,
  termsHash: string,
  status?: InvoiceStatusInfo,
): void {
  const invoice = terms.invoice_number;
  builder.y = Math.min(builder.y, 180);
  if (builder.y < MARGIN + 90) beginPage(builder, `Invoice ${invoice} (continued)`);
  if (status?.status === "Paid" && status.receiptId !== undefined) {
    label(builder, "RECEIPT", MARGIN, builder.y);
    builder.y -= 12;
    text(builder, MARGIN, builder.y, 7, "/F1", GRAY, status.receiptId);
    builder.y -= 12;
    if (status.verifyCommand !== undefined) {
      wrapped(builder, status.verifyCommand, MARGIN, WIDTH, 7, "/F1", GRAY);
    }
    builder.y -= 12;
  }
  label(builder, "TERMS HASH", MARGIN, builder.y);
  builder.y -= 12;
  text(builder, MARGIN, builder.y, 7, "/F1", GRAY, termsHash);
  builder.y -= 12;
  label(builder, "CLAUSES", MARGIN, builder.y);
  builder.y -= 12;
  drawClauses(builder, terms, invoice);
}

export function renderInvoicePdf(
  terms: Terms,
  termsHash: string,
  issuedAt?: string,
  lineItems?: readonly LineItem[],
  status?: InvoiceStatusInfo,
): Uint8Array {
  const builder: PageBuilder = { pages: [], content: "", y: PAGE_HEIGHT - MARGIN };
  beginPage(builder, null);
  drawTop(builder, terms, issuedAt);
  drawTable(builder, terms, lineItems);
  drawTotals(builder, terms, status);
  drawPayment(builder, terms);
  drawTerms(builder, terms, termsHash, status);
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

export function renderInvoicePdfBase64(
  terms: Terms,
  termsHash: string,
  issuedAt?: string,
  lineItems?: readonly LineItem[],
  status?: InvoiceStatusInfo,
): string {
  return Buffer.from(renderInvoicePdf(terms, termsHash, issuedAt, lineItems, status)).toString(
    "base64",
  );
}

export interface ReceiptDocument {
  receipt_id: string;
  paid_at: string;
  invoice_number: string;
  order_ref?: string | null;
  business_name?: string | null;
  business_username?: string | null;
  buyer_name?: string | null;
  amount_usd?: string | null;
  paid_amount: string;
  paid_asset: string;
  network?: string | null;
  fee_usd?: string | null;
  payer_tx?: { hash?: string; chain?: string; sender?: string } | null;
  near_tx: string;
  claim_account: string;
  terms_fingerprint: string;
  verify_command: string;
}

function drawReceiptTop(builder: PageBuilder, receipt: ReceiptDocument): void {
  const top = builder.y;
  text(builder, RIGHT, top + 4, 30, "/F3", INK, "Receipt", "right");
  text(builder, RIGHT, top - 16, 9, "/F1", GRAY, receipt.receipt_id, "right");
  text(builder, RIGHT, top - 40, 14, "/F2", ACCENT, "PAID", "right");

  label(builder, "FROM", MARGIN, top);
  builder.y = top - 16;
  wrapped(builder, receipt.business_name ?? "Openrail business", MARGIN, 260, 12, "/F2", INK);
  if (receipt.business_username !== null && receipt.business_username !== undefined) {
    wrapped(builder, `@${receipt.business_username}`, MARGIN, 260, 9, "/F1", GRAY);
  }

  builder.y = Math.min(builder.y, top - 70);
  line(builder, MARGIN, builder.y, RIGHT, builder.y, 0.8, ACCENT);
  line(builder, MARGIN, builder.y - 3, RIGHT, builder.y - 3, 0.8, ACCENT);
  builder.y -= 24;

  const blockTop = builder.y;
  label(builder, "BILLED TO", MARGIN, blockTop);
  builder.y = blockTop - 16;
  wrapped(builder, receipt.buyer_name ?? "—", MARGIN, 240, 11, "/F2", INK);
  const detailX = 360;
  label(builder, "PAID AT", detailX, blockTop);
  text(builder, RIGHT, blockTop, 9, "/F1", INK, formatDate(receipt.paid_at), "right");
  label(builder, "CLAIM ACCOUNT", detailX, blockTop - 16);
  text(builder, detailX, blockTop - 28, 8, "/F1", INK, receipt.claim_account);
  builder.y = Math.min(builder.y, blockTop - 40) - 8;
}

export function renderReceiptPdf(receipt: ReceiptDocument): Uint8Array {
  const builder: PageBuilder = { pages: [], content: "", y: PAGE_HEIGHT - MARGIN };
  beginPage(builder, null);
  drawReceiptTop(builder, receipt);

  builder.y -= 40;
  const tableTop = builder.y;
  label(builder, "DESCRIPTION", MARGIN, tableTop);
  text(builder, RIGHT, tableTop, 7, "/F2", ACCENT, "AMOUNT", "right");
  builder.y = tableTop - 8;
  line(builder, MARGIN, builder.y, RIGHT, builder.y, 0.5, ACCENT);
  builder.y -= 18;
  const reference = `Payment for ${receipt.invoice_number}${receipt.order_ref ? ` (${receipt.order_ref})` : ""}`;
  wrapped(builder, reference, MARGIN, 300, 9, "/F1", INK);
  text(builder, RIGHT, tableTop - 18, 9, "/F1", INK, `$${receipt.amount_usd ?? "0.00"}`, "right");
  builder.y -= 8;
  line(builder, MARGIN, builder.y, RIGHT, builder.y, 0.35, "0.82 0.82 0.82");
  builder.y -= 8;

  builder.y -= 12;
  line(builder, 360, builder.y, RIGHT, builder.y, 1.2, ACCENT);
  builder.y -= 18;
  text(builder, 360, builder.y, 10, "/F2", INK, "AMOUNT PAID");
  text(builder, RIGHT, builder.y, 12, "/F2", ACCENT, `$${receipt.amount_usd ?? "0.00"}`, "right");
  builder.y -= 14;
  text(
    builder,
    360,
    builder.y,
    8,
    "/F1",
    GRAY,
    `Paid in ${receipt.paid_amount} ${receipt.paid_asset}`,
  );
  builder.y -= 14;
  text(builder, 360, builder.y, 8, "/F1", GRAY, `Fee $${receipt.fee_usd ?? "0.00"}`);
  builder.y -= 30;

  const network = receipt.network ?? receipt.payer_tx?.chain ?? "—";
  for (const [caption, value] of [
    ["PAYER'S TRANSACTION", receipt.payer_tx?.hash ?? "—"],
    ["NEAR BOOKING TRANSACTION", receipt.near_tx],
    ["NETWORK", network],
  ] as const) {
    label(builder, caption, MARGIN, builder.y);
    builder.y -= 12;
    wrapped(builder, value, MARGIN, WIDTH, 8, "/F1", INK);
    builder.y -= 4;
  }

  builder.y = Math.min(builder.y, 180);
  label(builder, "TERMS FINGERPRINT", MARGIN, builder.y);
  builder.y -= 12;
  wrapped(builder, receipt.terms_fingerprint, MARGIN, WIDTH, 7, "/F1", GRAY);
  builder.y -= 8;
  label(builder, "VERIFY", MARGIN, builder.y);
  builder.y -= 12;
  wrapped(builder, receipt.verify_command, MARGIN, WIDTH, 7, "/F1", GRAY);
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

export function renderReceiptPdfBase64(receipt: ReceiptDocument): string {
  return Buffer.from(renderReceiptPdf(receipt)).toString("base64");
}

export interface StatementPaymentRow {
  /** ISO timestamp of the booking. */
  date: string;
  /** Invoice number, order reference or a short claim label. */
  from: string;
  /** USDC base units (6 decimals). */
  amount: string;
}

export interface StatementCashoutRow {
  date: string;
  /** Destination address, abbreviated for the sheet. */
  to: string;
  /** USDC base units (6 decimals). */
  amount: string;
}

export interface StatementDocument {
  businessName: string;
  from: string;
  to: string;
  generatedAt: string;
  /** Fingerprint of the statement data; the envelope hashes the final PDF bytes. */
  fingerprint: string;
  payments: readonly StatementPaymentRow[];
  cashouts: readonly StatementCashoutRow[];
}

const SPAGE_WIDTH = 595.28;
const SPAGE_HEIGHT = 841.89;
const SMARGIN = 45;
const SRIGHT = SPAGE_WIDTH - SMARGIN;
const SWIDTH = SRIGHT - SMARGIN;
const SFOOTER_Y = 34;
const SROW_H = 18;
const STABLE_HEADER_H = 22;

interface StatementBuilder {
  pages: string[];
  content: string;
  y: number;
  page: number;
}

function sBeginPage(builder: StatementBuilder, continuation: string | null): void {
  if (builder.content !== "") builder.pages.push(builder.content);
  builder.page += 1;
  builder.content = "";
  builder.y = SPAGE_HEIGHT - SMARGIN;
  drawCorners(builder);
  if (continuation !== null) {
    text(builder, 150, builder.y, 10, "/F2", GRAY, continuation);
    builder.y -= 22;
  }
}

function drawCorners(builder: StatementBuilder): void {
  // Indigo corner shapes, deliberately vector paths rather than images.
  builder.content += `0.247 0.275 0.996 rg\n0 ${(SPAGE_HEIGHT - 95).toFixed(2)} m 0 ${SPAGE_HEIGHT.toFixed(2)} l 128 ${SPAGE_HEIGHT.toFixed(2)} l f\n`;
  builder.content += `0.93 0.94 1 rg\n0 ${(SPAGE_HEIGHT - 145).toFixed(2)} m 0 ${SPAGE_HEIGHT.toFixed(2)} l 74 ${SPAGE_HEIGHT.toFixed(2)} l f\n`;
  builder.content += `0.247 0.275 0.996 rg\n${SPAGE_WIDTH.toFixed(2)} 0 m ${SPAGE_WIDTH.toFixed(2)} 96 l ${(SPAGE_WIDTH - 122).toFixed(2)} 0 l f\n`;
  builder.content += `0.93 0.94 1 rg\n${SPAGE_WIDTH.toFixed(2)} 0 m ${SPAGE_WIDTH.toFixed(2)} 142 l ${(SPAGE_WIDTH - 72).toFixed(2)} 0 l f\n`;
}

function fillRect(
  builder: StatementBuilder,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  builder.content += `${color} rg\n${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`;
}

function fitText(value: string, maxWidth: number, size: number, font: Font): string {
  if (measureTextWidth(font, value, size) <= maxWidth) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureTextWidth(font, `${value.slice(0, mid)}...`, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${value.slice(0, lo)}...`;
}

const ST_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function statementDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match === null) return value;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return value;
  return `${ST_MONTHS[month - 1]} ${day}, ${match[1]}`;
}

function statementPeriod(from: string, to: string): string {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(from);
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(to);
  if (a === null || b === null) return `${from} to ${to}`;
  const aMonth = Number(a[2]);
  const bMonth = Number(b[2]);
  const aDay = Number(a[3]);
  const bDay = Number(b[3]);
  if (a[1] === b[1]) {
    if (aMonth === bMonth)
      return `${ST_MONTHS[aMonth - 1] ?? ""} ${aDay} to ${ST_MONTHS[bMonth - 1] ?? ""} ${bDay}, ${a[1]}`;
    return `${ST_MONTHS[aMonth - 1] ?? ""} ${aDay} to ${ST_MONTHS[bMonth - 1] ?? ""} ${bDay}, ${a[1]}`;
  }
  return `${statementDate(from)} to ${statementDate(to)}`;
}

function baseUnits(value: string): bigint {
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function usdText(value: string): string {
  const units = baseUnits(value);
  // USDC has six decimals; round the exact amount once, half up, to cents.
  const cents = (units + 5_000n) / 10_000n;
  return `$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function totalText(rows: readonly { amount: string }[]): string {
  let total = 0n;
  for (const row of rows) total += baseUnits(row.amount);
  return usdText(total.toString());
}

function drawStatementTableHeader(builder: StatementBuilder, kind: "payments" | "cashouts"): void {
  const top = builder.y;
  fillRect(builder, SMARGIN, top - STABLE_HEADER_H, SWIDTH, STABLE_HEADER_H, ACCENT);
  const title = kind === "payments" ? "PAYMENTS" : "CASH-OUTS";
  text(
    builder,
    SMARGIN + SWIDTH / 2 - measureTextWidth("/F2", title, 11) / 2,
    top - 15,
    11,
    "/F2",
    "1 1 1",
    title,
  );
  builder.y = top - STABLE_HEADER_H;
  const columns: Array<[string, number]> =
    kind === "payments"
      ? [
          ["NO", SMARGIN + 8],
          ["DATE (UTC)", SMARGIN + 40],
          ["FROM", SMARGIN + 145],
          ["AMOUNT", SRIGHT - 8],
        ]
      : [
          ["NO", SMARGIN + 8],
          ["DATE", SMARGIN + 40],
          ["TO", SMARGIN + 145],
          ["AMOUNT", SRIGHT - 8],
        ];
  for (const [label, x] of columns) {
    const align = label === "AMOUNT" ? "right" : "left";
    text(builder, Number(x), builder.y - 14, 7, "/F2", GRAY, label, align);
  }
  builder.y -= STABLE_HEADER_H;
  line(builder, SMARGIN, builder.y, SRIGHT, builder.y, 0.6, "0.82 0.82 0.82");
}

function ensureStatementSpace(
  builder: StatementBuilder,
  needed: number,
  continuation: string,
): void {
  if (builder.y - needed >= SMARGIN + 64) return;
  sBeginPage(builder, continuation);
}

function drawStatementTable(
  builder: StatementBuilder,
  kind: "payments" | "cashouts",
  rows: readonly { date: string; from?: string; to?: string; amount: string }[],
  totalLabel: string,
  emptyText: string,
): void {
  const continuation =
    kind === "payments" ? "Settled Payments (continued)" : "Cash-outs (continued)";
  ensureStatementSpace(builder, 80, continuation);
  drawStatementTableHeader(builder, kind);
  if (rows.length === 0) {
    ensureStatementSpace(builder, SROW_H + 18, continuation);
    text(builder, SMARGIN + 8, builder.y - 13, 9, "/F1", GRAY, emptyText);
    builder.y -= SROW_H;
    line(builder, SMARGIN, builder.y, SRIGHT, builder.y, 0.35, "0.82 0.82 0.82");
  }
  for (const [index, row] of rows.entries()) {
    ensureStatementSpace(builder, SROW_H + 12, continuation);
    if (builder.y === SPAGE_HEIGHT - SMARGIN - 22) drawStatementTableHeader(builder, kind);
    const y = builder.y - 13;
    text(builder, SMARGIN + 8, y, 8, "/F1", INK, String(index + 1));
    text(builder, SMARGIN + 40, y, 8, "/F1", INK, statementDate(row.date));
    text(
      builder,
      SMARGIN + 145,
      y,
      8,
      "/F1",
      INK,
      fitText(row.from ?? row.to ?? "", SRIGHT - (SMARGIN + 145) - 82, 8, "/F1"),
    );
    text(builder, SRIGHT - 8, y, 8, "/F1", INK, usdText(row.amount), "right");
    builder.y -= SROW_H;
    line(builder, SMARGIN, builder.y, SRIGHT, builder.y, 0.35, "0.88 0.88 0.88");
  }
  ensureStatementSpace(builder, 26, continuation);
  const y = builder.y - 13;
  text(builder, SMARGIN + 8, y, 9, "/F2", INK, totalLabel);
  text(builder, SRIGHT - 8, y, 9, "/F2", ACCENT, totalText(rows), "right");
  builder.y -= 23;
  line(builder, SMARGIN, builder.y, SRIGHT, builder.y, 0.8, ACCENT);
  builder.y -= 18;
}

function drawStatementFooter(builder: StatementBuilder, page: number, total: number): void {
  const baseline = SFOOTER_Y + 8;
  text(builder, SMARGIN, baseline, 7, "/F1", GRAY, "Powered by");
  // The wordmark sits on the text baseline and stays above the rule.
  drawWordmark(builder, SMARGIN + 50, baseline - 3, 0.035);
  text(builder, SRIGHT - 40, baseline, 8, "/F1", GRAY, `${page} / ${total}`, "right");
  line(builder, SMARGIN, SFOOTER_Y - 4, SRIGHT, SFOOTER_Y - 4, 0.35, "0.86 0.86 0.86");
}

function drawWordmarkPath(
  builder: StatementBuilder,
  path: string,
  tx: number,
  ty: number,
  x: number,
  y: number,
  scale: number,
): void {
  const tokens = path.match(/[MLCZ]|-?\d*\.?\d+/g) ?? [];
  let i = 0;
  while (i < tokens.length) {
    const command = tokens[i++] ?? "";
    if (command === "M" || command === "L") {
      const gx = Number(tokens[i++] ?? 0);
      const gy = Number(tokens[i++] ?? 0);
      const px = x + (tx + gx) * scale;
      const py = y + (WORDMARK_VIEWBOX.height - (ty + gy)) * scale;
      builder.content += `${px.toFixed(2)} ${py.toFixed(2)} ${command === "M" ? "m" : "l"}\n`;
    } else if (command === "C") {
      const points: string[] = [];
      for (let n = 0; n < 6; n += 2) {
        const gx = Number(tokens[i++] ?? 0);
        const gy = Number(tokens[i++] ?? 0);
        points.push(
          `${(x + (tx + gx) * scale).toFixed(2)} ${(y + (WORDMARK_VIEWBOX.height - (ty + gy)) * scale).toFixed(2)}`,
        );
      }
      builder.content += `${points.join(" ")} c\n`;
    } else if (command === "Z") {
      builder.content += "h\n";
    }
  }
}

function drawWordmark(builder: StatementBuilder, x: number, y: number, scale: number): void {
  const transforms: Array<[number, number]> = [
    [0, 0],
    [290.32734, 248.512756],
    [420.963874, 248.512756],
    [544.485331, 248.512756],
    [674.46653, 248.512756],
    [763.44242, 248.512756],
    [884.904249, 248.512756],
    [947.85394, 248.512756],
  ];
  builder.content += `q\n${ACCENT} rg\nn\n`;
  for (const [index, path] of WORDMARK_PATHS.entries()) {
    const [tx, ty] = transforms[index] ?? [0, 0];
    drawWordmarkPath(builder, path, tx, ty, x, y, scale);
  }
  builder.content += "f\nQ\n";
}

/** Deterministic financial statement, one page per table overflow. */
export function renderStatementPdf(document: StatementDocument): Uint8Array {
  const builder: StatementBuilder = { pages: [], content: "", y: SPAGE_HEIGHT - SMARGIN, page: 0 };
  sBeginPage(builder, null);
  const business = fitText(document.businessName, SWIDTH - 40, 18, "/F2");
  text(
    builder,
    SMARGIN + (SWIDTH - measureTextWidth("/F2", business, 18)) / 2,
    SPAGE_HEIGHT - 92,
    18,
    "/F2",
    INK,
    business,
  );
  const titleY = SPAGE_HEIGHT - 142;
  const first = "Settled";
  const second = "Payments";
  const gap = 10;
  const titleWidth = measureTextWidth("/F2", first, 34) + gap + measureTextWidth("/F2", second, 34);
  const titleX = SMARGIN + (SWIDTH - titleWidth) / 2;
  text(builder, titleX, titleY, 34, "/F2", INK, first);
  text(
    builder,
    titleX + measureTextWidth("/F2", first, 34) + gap,
    titleY,
    34,
    "/F2",
    ACCENT,
    second,
  );
  const period = `Statement, ${statementPeriod(document.from, document.to)}`;
  text(
    builder,
    SMARGIN + (SWIDTH - measureTextWidth("/F1", period, 10)) / 2,
    titleY - 38,
    10,
    "/F1",
    GRAY,
    period,
  );
  builder.y = titleY - 76;

  drawStatementTable(
    builder,
    "payments",
    document.payments,
    "Total received",
    "None in this period",
  );
  drawStatementTable(
    builder,
    "cashouts",
    document.cashouts,
    "Total cashed out",
    "None in this period",
  );
  ensureStatementSpace(builder, 32, "Statement (continued)");
  let receivedUnits = 0n;
  for (const row of document.payments) receivedUnits += baseUnits(row.amount);
  let cashedUnits = 0n;
  for (const row of document.cashouts) cashedUnits += baseUnits(row.amount);
  const leftUnits = receivedUnits > cashedUnits ? receivedUnits - cashedUnits : 0n;
  text(builder, SMARGIN, builder.y, 12, "/F2", INK, "Left in balance:");
  text(builder, SRIGHT, builder.y, 12, "/F2", ACCENT, usdText(leftUnits.toString()), "right");
  builder.y -= 46;
  ensureStatementSpace(builder, 66, "Statement (continued)");
  text(builder, SMARGIN, builder.y, 7, "/F1", GRAY, `Fingerprint: ${document.fingerprint}`);
  builder.y -= 12;
  text(
    builder,
    SMARGIN,
    builder.y,
    7,
    "/F1",
    GRAY,
    `Generated ${formatDateTime(document.generatedAt)}`,
  );
  builder.y -= 12;
  text(builder, SMARGIN, builder.y, 7, "/F1", GRAY, "Amounts are USDC settled on NEAR.");
  builder.y -= 12;
  text(builder, SMARGIN, builder.y, 7, "/F1", GRAY, "Totals are rounded once from exact amounts.");
  finishPages(builder);
  const totalPages = builder.pages.length;
  builder.pages = builder.pages.map((page, index) => {
    const pageBuilder: StatementBuilder = { pages: [], content: page, y: 0, page: index + 1 };
    drawStatementFooter(pageBuilder, index + 1, totalPages);
    return pageBuilder.content;
  });

  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Kids [${builder.pages.map((_, index) => `${7 + index * 2} 0 R`).join(" ")}] /Count ${builder.pages.length} >>`,
  );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>");

  builder.pages.forEach((content, index) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${SPAGE_WIDTH} ${SPAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${8 + index * 2} 0 R >>`,
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
