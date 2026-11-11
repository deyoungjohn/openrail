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
