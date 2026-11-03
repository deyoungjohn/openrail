/** CSV/PDF statements per claim and per period; totals come from indexed events. */
import { createHash } from "node:crypto";
import type { IndexerStore, StatementSourceRow } from "./store.js";
import type { ClaimReader, StatementRange } from "./types.js";

export const PAYMENT_INSTRUCTION_V1 =
  "Payment of any amount to any address listed in this invoice or at its pay link discharges this invoice to that extent.";

export interface StatementRow extends StatementSourceRow {
  invoice_number: string;
  reconciles: boolean | null;
}

export interface StatementEnvelope {
  format: "csv" | "pdf";
  filename: string;
  content_type: string;
  content_base64: string;
  sha256: string;
  generated_at: string;
  from: string;
  to: string;
  token_id?: string;
}

function sha256Hex0x(value: string): string {
  return `0x${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function dateStart(value: string): number {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed)) throw new Error("INVALID_DATE");
  return Math.floor(parsed / 1000);
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function sameAmount(indexed: bigint, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  try {
    return indexed === BigInt(actual);
  } catch {
    return false;
  }
}

export async function statementRows(
  store: IndexerStore,
  range: StatementRange,
  claimReader?: ClaimReader,
): Promise<StatementRow[]> {
  const fromTs = dateStart(range.from);
  const toTs = dateStart(range.to) + 86_400; // inclusive end date
  if (toTs <= fromTs) throw new Error("INVALID_RANGE");
  const rows = store.statementRows(fromTs, toTs, range.tokenId);
  return Promise.all(
    rows.map(async (row) => {
      let reconciles: boolean | null = null;
      if (claimReader !== undefined) {
        try {
          const claim = await claimReader.claim(row.token_id);
          reconciles =
            claim !== null &&
            sameAmount(row.booked_total, claim.booked_total) &&
            sameAmount(row.distributed_total, claim.distributed_total) &&
            sameAmount(row.fee_total, claim.fee_total) &&
            sameAmount(row.surplus, claim.surplus) &&
            sameAmount(row.credit_total, claim.credit_total) &&
            sameAmount(BigInt(row.amount_due), claim.amount_due);
        } catch {
          reconciles = null;
        }
      }
      return { ...row, invoice_number: row.token_id, reconciles };
    }),
  );
}

export function renderCsv(rows: StatementRow[]): string {
  const header = [
    "token_id",
    "invoice_number",
    "amount_due",
    "booked_total",
    "fee_total",
    "distributed_total",
    "surplus",
    "credit_total",
    "status",
    "due_date",
    "terms_hash",
    "bookings",
    "reconciles",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.token_id,
        row.invoice_number,
        row.amount_due,
        row.booked_total.toString(),
        row.fee_total.toString(),
        row.distributed_total.toString(),
        row.surplus.toString(),
        row.credit_total.toString(),
        row.status,
        String(row.due_date),
        row.terms_hash,
        String(row.bookings),
        row.reconciles === null ? "" : String(row.reconciles),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function escapePdfText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

export function renderPdf(lines: string[]): Uint8Array {
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

export function renderStatementPdf(rows: StatementRow[]): Uint8Array {
  const lines = [
    "OPENRAIL STATEMENT",
    "",
    `Period: ${rows.length === 0 ? "no claims" : `${rows[0]?.token_id ?? ""}`}`,
    ...rows.flatMap((row) => [
      `Claim ${row.token_id} (${row.status})`,
      `  Amount due: ${row.amount_due}`,
      `  Booked: ${row.booked_total.toString()}  Fee: ${row.fee_total.toString()}  Net: ${row.distributed_total.toString()}`,
      `  Surplus: ${row.surplus.toString()}  Credit: ${row.credit_total.toString()}`,
      `  Terms: ${row.terms_hash}`,
    ]),
  ];
  return renderPdf(lines);
}

export async function buildStatement(
  store: IndexerStore,
  range: StatementRange,
  claimReader?: ClaimReader,
  now: Date = new Date(),
): Promise<StatementEnvelope> {
  const rows = await statementRows(store, range, claimReader);
  const generatedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const base =
    range.tokenId === undefined
      ? `statement-${range.from}-${range.to}`
      : `statement-${range.tokenId}-${range.from}-${range.to}`;
  if (range.format === "csv") {
    const csv = renderCsv(rows);
    return {
      format: "csv",
      filename: `${base}.csv`,
      content_type: "text/csv",
      content_base64: Buffer.from(csv, "utf8").toString("base64"),
      sha256: sha256Hex0x(csv),
      generated_at: generatedAt,
      from: range.from,
      to: range.to,
      ...(range.tokenId === undefined ? {} : { token_id: range.tokenId }),
    };
  }
  const pdf = renderStatementPdf(rows);
  return {
    format: "pdf",
    filename: `${base}.pdf`,
    content_type: "application/pdf",
    content_base64: Buffer.from(pdf).toString("base64"),
    sha256: `0x${createHash("sha256").update(pdf).digest("hex")}`,
    generated_at: generatedAt,
    from: range.from,
    to: range.to,
    ...(range.tokenId === undefined ? {} : { token_id: range.tokenId }),
  };
}
