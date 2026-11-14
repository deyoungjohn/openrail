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

export type Font = "/F1" | "/F2" | "/F3" | "/F4" | "/F5";

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
  return (
    value
      .normalize("NFKD")
      // Dashes are ASCII here: a standard font prints anything else as "?" (an empty field showed "?", 14 Nov).
      .replace(/[\u2012-\u2015\u2212]/g, "-")
      .replace(/\u2026/g, "...")
      .replace(/[^\x20-\x7e]/g, "?")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
  );
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
  if (font === "/F5") return 600; // Courier: every glyph is 600 wide
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

function usdCents(value: string): bigint | null {
  const match = /^(\d+)\.(\d{2})$/.exec(value);
  if (match === null) return null;
  return BigInt(match[1] ?? "0") * 100n + BigInt(match[2] ?? "0");
}

/** The rows' sum, or null when a row's amount is not plain dollars and cents. */
function lineItemsTotal(items: readonly LineItem[]): string | null {
  let cents = 0n;
  for (const item of items) {
    const amount = usdCents(item.amount_usd);
    if (amount === null) return null;
    cents += amount;
  }
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

/**
 * The merchant's invoice, in the receipt's layout (14 Nov: one template for both). Every terms field is printed, the
 * terms hash is the fingerprint, and the verify command is set out as a terminal would show it.
 */
export function renderInvoicePdf(
  terms: Terms,
  termsHash: string,
  issuedAt?: string,
  lineItems?: readonly LineItem[],
  status?: InvoiceStatusInfo,
): Uint8Array {
  const builder: PageBuilder = { pages: [], content: "", y: PAGE_HEIGHT - MARGIN };
  const links: PdfLink[] = [];
  beginPage(builder, null);
  const paid = status?.status === "Paid";
  const due =
    status?.status === "PartiallyPaid" && status.outstandingUsd !== undefined
      ? status.outstandingUsd
      : terms.amount_usd;
  const facts = [`No: ${terms.invoice_number}`];
  if (issuedAt !== undefined) facts.push(`Issued : ${formatDate(issuedAt)}`);
  facts.push(`Due : ${formatDate(terms.due_date)}`);
  if (paid && status?.paidAt !== undefined) facts.push(`Paid : ${formatDate(status.paidAt)}`);
  if (status?.status === "PartiallyPaid" && status.outstandingUsd !== undefined)
    facts.push(`Still due $${status.outstandingUsd}`);
  // Rows that do not add up to the terms amount are not printed: the one-row table shows the amount that binds.
  const rowsMatch =
    lineItems !== undefined &&
    lineItems.length > 0 &&
    lineItemsTotal(lineItems) === terms.amount_usd;
  const checkRows: [string, string, string | null][] = [
    [
      "Claim account",
      terms.claim_account,
      `https://nearblocks.io/address/${encodeURIComponent(terms.claim_account)}`,
    ],
    ["Issued by", terms.issuer_account, null],
    ["Terms fingerprint", termsHash, null],
  ];
  if (paid && status?.receiptId !== undefined) checkRows.push(["Receipt", status.receiptId, null]);
  drawDoc(
    builder,
    {
      businessName: terms.issuer_legal_name,
      title: "INVOICE",
      mark: status === undefined ? "" : statusMark(status.status),
      toLabel: "Invoice to :",
      toName: terms.debtor_legal_name,
      address: null,
      // `anyone.<root>` stands in for "no client account was given": not an account, so it is not printed.
      toDetail: /^anyone\./.test(terms.debtor_key) ? null : terms.debtor_key,
      facts,
      factNote: status === undefined ? null : `As of ${formatDateTime(status.generatedAt)}`,
      amountLabel: paid ? "Amount paid" : "Amount due",
      amountUsd: paid ? terms.amount_usd : due,
      items:
        rowsMatch && lineItems !== undefined
          ? lineItems
          : [
              {
                description: terms.invoice_number,
                quantity: 1,
                unit_amount_usd: terms.amount_usd,
                amount_usd: terms.amount_usd,
              },
            ],
      subtotalUsd: terms.amount_usd,
      feeUsd: null,
      totalLabel: paid ? "Total paid :" : "Total due :",
      totalUsd: paid ? terms.amount_usd : due,
      methodLabel: "Pay online :",
      methodLines: [{ text: terms.pay_link, url: terms.pay_link }],
      checkRows,
      verifyCommand:
        status?.verifyCommand ??
        `openrail-verify claim ${terms.claim_account} --terms-hash ${termsHash}`,
      clauses: terms.clauses,
      continuation: `Invoice ${terms.invoice_number} (continued)`,
    },
    links,
  );
  finishPages(builder);
  return assemble(builder, links);
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
  /** What was paid for (the invoice's lines); one line for the payment when absent. */
  line_items?: LineItem[] | null;
  /** The client's address, as the business typed it. */
  client_address?: string | null;
  terms_fingerprint: string;
  verify_command: string;
}

const ON_ACCENT = "1 1 1";
const RULE = "0.16 0.16 0.16";

/** Transaction pages on each chain's explorer (the same ones the web app links to). */
const EXPLORER_TX: Record<string, string> = {
  near: "https://nearblocks.io/txns/",
  ethereum: "https://etherscan.io/tx/",
  base: "https://basescan.org/tx/",
  arbitrum: "https://arbiscan.io/tx/",
  optimism: "https://optimistic.etherscan.io/tx/",
  polygon: "https://polygonscan.com/tx/",
  bnb: "https://bscscan.com/tx/",
  solana: "https://solscan.io/tx/",
};

const CHAIN_LABEL: Record<string, string> = {
  near: "NEAR",
  ethereum: "Ethereum",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  polygon: "Polygon",
  bnb: "BNB Chain",
  solana: "Solana",
};

/** The chain a settlement asset id lives on (`nep141:sol-...` is USDC bridged from Solana). */
function assetChain(asset: string): string {
  if (/:sol-/.test(asset)) return "solana";
  if (/:base-/.test(asset)) return "base";
  if (/:arb-/.test(asset)) return "arbitrum";
  if (/:eth-/.test(asset)) return "ethereum";
  return "near";
}

/** Base units with 6 decimals as `7.00` (two decimals, the receipt shows dollars). */
function sixDecimals(units: string): string | null {
  if (!/^\d+$/.test(units)) return null;
  const cents = (BigInt(units) + 5_000n) / 10_000n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

interface PdfLink {
  page: number;
  rect: [number, number, number, number];
  url: string;
}

function fill(
  builder: PageBuilder,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  builder.content += `${color} rg\n${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`;
}

/** Text that opens a link when clicked (a URI annotation over it). */
function linked(
  builder: PageBuilder,
  links: PdfLink[],
  x: number,
  y: number,
  size: number,
  value: string,
  url: string | null,
): void {
  text(builder, x, y, size, "/F1", url === null ? INK : ACCENT, value);
  if (url === null) return;
  const width = measureTextWidth("/F1", value, size);
  line(builder, x, y - 1.5, x + width, y - 1.5, 0.4, ACCENT);
  links.push({ page: builder.pages.length, rect: [x, y - 3, x + width, y + size], url });
}

/** One document in the receipt's layout: a receipt (paid) or an invoice (the merchant's copy). */
interface DocLayout {
  businessName: string;
  businessUsername?: string | null;
  title: "RECEIPT" | "INVOICE";
  mark: string;
  toLabel: string;
  toName: string;
  address: string | null;
  /** Under the address: the client's account or key, when there is one. */
  toDetail?: string | null;
  /** Right column, top to bottom: number, dates, the document id. */
  facts: string[];
  factNote?: string | null;
  amountLabel: string;
  amountUsd: string;
  items: readonly {
    description: string;
    quantity: number | string;
    unit_amount_usd: string;
    amount_usd: string;
  }[];
  subtotalUsd: string;
  feeUsd: string | null;
  totalLabel: string;
  totalUsd: string;
  methodLabel: string;
  methodLines: { text: string; url: string | null }[];
  checkRows: [string, string, string | null][];
  verifyCommand: string | null;
  clauses?: readonly string[];
  continuation: string;
}

const dash = (value: string | null | undefined): string =>
  value === null || value === undefined || value.trim() === "" ? "-" : value;

/** `openrail-verify claim <account> --terms-hash <hash>` as a shell command: one flag a line, `\` at the end. */
export function cliLines(command: string): string[] {
  const parts = command.trim().split(/\s+(?=--)/);
  return parts.map(
    (part, i) => `${i === 0 ? "$ " : "    "}${part}${i < parts.length - 1 ? " \\" : ""}`,
  );
}

const CODE_BG = "0.955 0.955 0.965";
const CODE_INK = "0.15 0.15 0.2";

/** A command in a grey box, in Courier, the way a terminal shows it. */
function drawCommand(builder: PageBuilder, command: string, continuation: string): void {
  const size = 7.2;
  const lines = cliLines(command).flatMap((l) => {
    // A line longer than the box is cut at the box and goes on, indented, below.
    const room = Math.floor((WIDTH - 20) / (size * 0.6));
    const out: string[] = [];
    let rest = l;
    while (rest.length > room) {
      out.push(rest.slice(0, room));
      rest = `      ${rest.slice(room)}`;
    }
    out.push(rest);
    return out;
  });
  const height = lines.length * (size + 3.5) + 12;
  if (builder.y - height < 50) beginPage(builder, continuation);
  const bottom = builder.y - height;
  fill(builder, MARGIN, bottom, WIDTH, height, CODE_BG);
  builder.y -= 6;
  for (const l of lines) {
    text(builder, MARGIN + 10, builder.y - size, size, "/F5", CODE_INK, l);
    builder.y -= size + 3.5;
  }
  builder.y = bottom - 14;
}

function drawDoc(builder: PageBuilder, doc: DocLayout, links: PdfLink[]): void {
  const top = PAGE_HEIGHT - 70;
  builder.y = top;
  wrapped(builder, doc.businessName, MARGIN, 300, 18, "/F2", INK, 22);
  if (doc.businessUsername !== null && doc.businessUsername !== undefined)
    wrapped(builder, `@${doc.businessUsername}`, MARGIN, 300, 10, "/F1", GRAY, 14);
  text(builder, RIGHT, top - 8, 34, "/F1", INK, doc.title, "right");
  text(builder, RIGHT, top - 30, 10, "/F2", ACCENT, doc.mark, "right");

  const block = Math.min(builder.y - 26, top - 80);
  text(builder, MARGIN, block, 9, "/F1", INK, doc.toLabel);
  builder.y = block - 20;
  wrapped(builder, dash(doc.toName), MARGIN, 280, 16, "/F2", INK, 20);
  if (doc.toDetail) wrapped(builder, doc.toDetail, MARGIN, 280, 8.5, "/F1", GRAY, 11);
  builder.y -= 8;
  text(builder, MARGIN, builder.y, 8, "/F2", INK, "Address");
  builder.y -= 12;
  const address = (doc.address ?? "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (address.length === 0) address.push("-");
  for (const part of address) wrapped(builder, part, MARGIN, 280, 8.5, "/F1", INK, 11);
  builder.y -= 6;

  let fy = block;
  for (const fact of doc.facts) {
    text(builder, RIGHT, fy, 9, "/F1", INK, fact, "right");
    fy -= 16;
  }
  if (doc.factNote) {
    text(builder, RIGHT, fy, 7.5, "/F1", GRAY, doc.factNote, "right");
    fy -= 16;
  }
  fy -= 16;
  text(builder, RIGHT, fy, 9, "/F1", INK, doc.amountLabel, "right");
  text(builder, RIGHT, fy - 22, 18, "/F2", INK, `USD : $${doc.amountUsd}`, "right");
  builder.y = Math.min(builder.y, fy - 40);

  // The lines on an accent band, edge to edge.
  const bandTop = builder.y;
  fill(builder, 0, bandTop - 24, PAGE_WIDTH, 24, ACCENT);
  const QTY_X = 372;
  const PRICE_RIGHT = 478;
  const head = bandTop - 16;
  text(builder, MARGIN, head, 9.5, "/F2", ON_ACCENT, "DESCRIPTION");
  text(builder, QTY_X, head, 9.5, "/F2", ON_ACCENT, "QTY");
  text(builder, PRICE_RIGHT, head, 9.5, "/F2", ON_ACCENT, "PRICE", "right");
  text(builder, RIGHT, head, 9.5, "/F2", ON_ACCENT, "TOTAL", "right");
  builder.y = bandTop - 24;
  for (const item of doc.items) {
    if (builder.y < 250) beginPage(builder, doc.continuation);
    const rowTop = builder.y - 20;
    builder.y = rowTop;
    wrapped(builder, item.description, MARGIN, 290, 10, "/F1", INK, 13);
    text(builder, QTY_X + 8, rowTop, 10, "/F1", INK, String(item.quantity), "right");
    text(builder, PRICE_RIGHT, rowTop, 10, "/F1", INK, `$${item.unit_amount_usd}`, "right");
    text(builder, RIGHT, rowTop, 10, "/F1", INK, `$${item.amount_usd}`, "right");
    builder.y = Math.min(builder.y, rowTop - 13) - 4;
    line(builder, MARGIN, builder.y, RIGHT, builder.y, 0.7, RULE);
  }

  // Payment method and totals.
  builder.y -= 26;
  const totalsTop = builder.y;
  text(builder, MARGIN, totalsTop, 10, "/F2", INK, doc.methodLabel);
  let my = totalsTop - 14;
  for (const m of doc.methodLines) {
    for (const part of wrapText(
      m.text,
      270,
      m.url === null ? 10 : 8.5,
      m.url === null ? "/F2" : "/F1",
    )) {
      if (m.url === null) text(builder, MARGIN, my, 10, "/F2", INK, part);
      else linked(builder, links, MARGIN, my, 8.5, part, m.url);
      my -= 13;
    }
  }
  text(builder, 440, totalsTop, 9.5, "/F1", INK, "Sub-total :", "right");
  text(builder, RIGHT, totalsTop, 9.5, "/F1", INK, `$${doc.subtotalUsd}`, "right");
  if (doc.feeUsd !== null) {
    text(builder, 440, totalsTop - 18, 9.5, "/F1", INK, "Fee :", "right");
    text(builder, RIGHT, totalsTop - 18, 9.5, "/F1", INK, `$${doc.feeUsd}`, "right");
  }
  const barY = totalsTop - 52;
  fill(builder, 352, barY, PAGE_WIDTH - 352, 26, ACCENT);
  text(builder, 440, barY + 9, 11, "/F2", ON_ACCENT, doc.totalLabel, "right");
  text(builder, RIGHT, barY + 9, 11, "/F2", ON_ACCENT, `$${doc.totalUsd}`, "right");
  builder.y = Math.min(barY, my) - 34;

  // Everything needed to check it onchain, with links.
  if (builder.y < 200) beginPage(builder, doc.continuation);
  text(builder, MARGIN, builder.y, 13, "/F1", INK, "Check it onchain");
  builder.y -= 20;
  for (const [caption, value, url] of doc.checkRows) {
    if (builder.y < 60) beginPage(builder, doc.continuation);
    text(builder, MARGIN, builder.y, 8, "/F2", INK, caption);
    builder.y -= 11;
    // A long hex value stays on one line in a smaller size (so it copies whole).
    const size = /^0x[0-9a-f]{40,}$/.test(value) ? 6.6 : 8;
    for (const part of wrapText(dash(value), WIDTH, size, "/F1")) {
      linked(builder, links, MARGIN, builder.y, size, part, url);
      builder.y -= size + 2;
    }
    builder.y -= 5;
  }
  if (doc.verifyCommand !== null) {
    if (builder.y < 90) beginPage(builder, doc.continuation);
    text(builder, MARGIN, builder.y, 8, "/F2", INK, "Verify");
    builder.y -= 8;
    drawCommand(builder, doc.verifyCommand, doc.continuation);
  }
  if (doc.clauses !== undefined && doc.clauses.length > 0) {
    if (builder.y < 80) beginPage(builder, doc.continuation);
    text(builder, MARGIN, builder.y, 8, "/F2", INK, "Terms");
    builder.y -= 12;
    for (const clause of doc.clauses) {
      for (const part of wrapText(`- ${clause}`, WIDTH, 7, "/F1")) {
        if (builder.y < MARGIN + 14) beginPage(builder, doc.continuation);
        text(builder, MARGIN, builder.y, 7, "/F1", GRAY, part);
        builder.y -= 9;
      }
      builder.y -= 2;
    }
  }
}

/** The page objects and fonts, links on their pages (one writer for the receipt and the invoice). */
function assemble(builder: PageBuilder, links: PdfLink[]): Uint8Array {
  const pageIds = builder.pages.map((_, index) => 8 + index * 2);
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${builder.pages.length} >>`,
  );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  builder.pages.forEach((content, index) => {
    const contentId = 9 + index * 2;
    const annots = links
      .filter((link) => link.page === index)
      .map(
        (link) =>
          `<< /Type /Annot /Subtype /Link /Rect [${link.rect.map((n) => n.toFixed(2)).join(" ")}] /Border [0 0 0] /A << /S /URI /URI (${escapePdfText(link.url)}) >> >>`,
      );
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R /F5 7 0 R >> >>${annots.length === 0 ? "" : ` /Annots [${annots.join(" ")}]`} /Contents ${contentId} 0 R >>`,
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

function centsText(cents: bigint): string {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function receiptLayout(receipt: ReceiptDocument): DocLayout {
  const amount = receipt.amount_usd ?? "0.00";
  const fee = receipt.fee_usd ?? "0.00";
  const sub = (usdCents(amount) ?? 0n) - (usdCents(fee) ?? 0n);
  const payerChain = receipt.payer_tx?.chain ?? receipt.network ?? null;
  const settledChain = assetChain(receipt.paid_asset);
  const settled = sixDecimals(receipt.paid_amount);
  const continuation = `Receipt ${receipt.receipt_id} (continued)`;
  return {
    businessName: receipt.business_name ?? "Openrail business",
    businessUsername: receipt.business_username ?? null,
    title: "RECEIPT",
    mark: "PAID",
    toLabel: "Receipt to :",
    toName: receipt.buyer_name ?? "-",
    address: receipt.client_address ?? null,
    facts: [`No: ${receipt.invoice_number}`, `Date : ${formatDate(receipt.paid_at)}`],
    factNote: receipt.receipt_id,
    amountLabel: "Amount paid",
    amountUsd: amount,
    items:
      receipt.line_items !== undefined &&
      receipt.line_items !== null &&
      receipt.line_items.length > 0
        ? receipt.line_items
        : [
            {
              description: `Payment for ${receipt.invoice_number}`,
              quantity: 1,
              unit_amount_usd: amount,
              amount_usd: amount,
            },
          ],
    subtotalUsd: centsText(sub),
    feeUsd: fee,
    totalLabel: "Total paid :",
    totalUsd: amount,
    methodLabel: "Payment Method :",
    methodLines: [{ text: "Openrail", url: null }],
    checkRows: [
      [
        "Claim account",
        receipt.claim_account,
        `https://nearblocks.io/address/${encodeURIComponent(receipt.claim_account)}`,
      ],
      ["Terms fingerprint", receipt.terms_fingerprint, null],
      [
        "NEAR booking transaction",
        receipt.near_tx,
        `${EXPLORER_TX.near}${encodeURIComponent(receipt.near_tx)}`,
      ],
      [
        `Payer's transaction${payerChain ? ` (${CHAIN_LABEL[payerChain] ?? payerChain})` : ""}`,
        receipt.payer_tx?.hash ?? "-",
        receipt.payer_tx?.hash && payerChain && EXPLORER_TX[payerChain] !== undefined
          ? `${EXPLORER_TX[payerChain]}${encodeURIComponent(receipt.payer_tx.hash)}`
          : null,
      ],
      ["Network", payerChain ? (CHAIN_LABEL[payerChain] ?? payerChain) : "-", null],
      // The amount and the chain only: the token's contract id is a number nobody reading a receipt needs (14 Nov).
      [
        "Settled",
        settled === null ? "-" : `${settled} USDC on ${CHAIN_LABEL[settledChain] ?? settledChain}`,
        null,
      ],
      ["Order", receipt.order_ref ?? "-", null],
    ],
    verifyCommand: receipt.verify_command,
    continuation,
  };
}

/**
 * The receipt, laid out as the invoice template (13 Nov): business and RECEIPT on top, who paid and the amount, the
 * lines on an accent band, payment method and totals, then everything a reader needs to check it onchain, with
 * clickable explorer links and the verify command as a terminal would show it.
 */
export function renderReceiptPdf(receipt: ReceiptDocument): Uint8Array {
  const builder: PageBuilder = { pages: [], content: "", y: PAGE_HEIGHT - MARGIN };
  const links: PdfLink[] = [];
  beginPage(builder, null);
  drawDoc(builder, receiptLayout(receipt), links);
  finishPages(builder);
  return assemble(builder, links);
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

function sBeginPage(builder: StatementBuilder, continuation: string | null, topInset = 0): void {
  if (builder.content !== "") builder.pages.push(builder.content);
  builder.page += 1;
  builder.content = "";
  builder.y = SPAGE_HEIGHT - SMARGIN - topInset;
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

function ensureStatementSpace(builder: StatementBuilder, needed: number): boolean {
  if (builder.y - needed >= SMARGIN + 64) return false;
  sBeginPage(builder, null, 40);
  return true;
}

function drawStatementTable(
  builder: StatementBuilder,
  kind: "payments" | "cashouts",
  rows: readonly { date: string; from?: string; to?: string; amount: string }[],
  totalLabel: string,
  emptyText: string,
): void {
  ensureStatementSpace(builder, 80);
  drawStatementTableHeader(builder, kind);
  if (rows.length === 0) {
    if (ensureStatementSpace(builder, SROW_H + 18)) drawStatementTableHeader(builder, kind);
    text(builder, SMARGIN + 8, builder.y - 13, 9, "/F1", GRAY, emptyText);
    builder.y -= SROW_H;
    line(builder, SMARGIN, builder.y, SRIGHT, builder.y, 0.35, "0.82 0.82 0.82");
  }
  for (const [index, row] of rows.entries()) {
    if (ensureStatementSpace(builder, SROW_H + 12)) drawStatementTableHeader(builder, kind);
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
  if (ensureStatementSpace(builder, 26)) drawStatementTableHeader(builder, kind);
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
  drawWordmark(
    builder,
    SMARGIN + measureTextWidth("/F1", "Powered by", 7) + 4,
    baseline - 3,
    0.035,
  );
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
  ensureStatementSpace(builder, 32);
  let receivedUnits = 0n;
  for (const row of document.payments) receivedUnits += baseUnits(row.amount);
  let cashedUnits = 0n;
  for (const row of document.cashouts) cashedUnits += baseUnits(row.amount);
  const leftUnits = receivedUnits > cashedUnits ? receivedUnits - cashedUnits : 0n;
  text(builder, SMARGIN, builder.y, 12, "/F2", INK, "Left in balance:");
  text(builder, SRIGHT, builder.y, 12, "/F2", ACCENT, usdText(leftUnits.toString()), "right");
  builder.y -= 46;
  ensureStatementSpace(builder, 66);
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
