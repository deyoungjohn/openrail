/**
 * Canonical terms JSON and terms_hash (blueprint 2.6).
 *
 * Keys are sorted at every level, UTF-8, no whitespace; sha256 is over those
 * bytes. This must reproduce fixtures/vectors/terms-v1.json byte for byte.
 */
import { sha256Hex0x } from "./crypto.js";

export const TERMS_SCHEMA = "openrail.terms.v1";

export const CLAUSE_PAYMENT_INSTRUCTION_V1 =
  "Payment of any amount to any address listed in this invoice or at its pay link discharges this invoice to that extent.";
export const CLAUSE_ASSIGNMENT_CONSENT_V1 =
  "The debtor consents to the assignment of the right to receive payment; the payment addresses do not change on assignment.";

export const CORE_CLAUSES = [CLAUSE_PAYMENT_INSTRUCTION_V1, CLAUSE_ASSIGNMENT_CONSENT_V1];

export interface Terms {
  schema: string;
  invoice_number: string;
  issuer_legal_name: string;
  issuer_account: string;
  debtor_legal_name: string;
  debtor_key: string;
  amount_usd: string;
  due_date: string;
  line_items_sha256: string;
  claim_account: string;
  pay_link: string;
  assignment_agreement_sha256?: string;
  clauses: string[];
}

export function buildTerms(
  input: Omit<Terms, "schema" | "clauses"> & { clauses?: string[] },
): Terms {
  return {
    ...input,
    schema: TERMS_SCHEMA,
    clauses: input.clauses ?? [...CORE_CLAUSES],
  };
}

function isLowerHex32(value: string): boolean {
  return /^0x[0-9a-f]{64}$/.test(value);
}

function isTwoDecimalAmount(value: string): boolean {
  return /^[0-9]+\.[0-9]{2}$/.test(value) && value.length <= 40;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isIso8601Utc(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value);
  if (match === null) return false;
  const [, year, month, day, hour, minute, second] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  return (
    m >= 1 &&
    m <= 12 &&
    d >= 1 &&
    d <= daysInMonth(y, m) &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59
  );
}

export function validateTerms(terms: Terms): void {
  if (terms.schema !== TERMS_SCHEMA)
    throw new Error(`TERMS_INVALID: schema must be ${TERMS_SCHEMA}`);
  if (!isTwoDecimalAmount(terms.amount_usd)) {
    throw new Error("TERMS_INVALID: amount_usd must be a string with exactly two decimals");
  }
  if (!isLowerHex32(terms.line_items_sha256)) {
    throw new Error("TERMS_INVALID: line_items_sha256 must be 0x + 64 lowercase hex");
  }
  if (
    terms.assignment_agreement_sha256 !== undefined &&
    !isLowerHex32(terms.assignment_agreement_sha256)
  ) {
    throw new Error("TERMS_INVALID: assignment_agreement_sha256 must be 0x + 64 lowercase hex");
  }
  if (!isIso8601Utc(terms.due_date)) {
    throw new Error("TERMS_INVALID: due_date must be YYYY-MM-DDTHH:MM:SSZ");
  }
}

/** Sorted, compact JSON. `assignment_agreement_sha256` is omitted, never null. */
export function canonicalTerms(terms: Terms): string {
  validateTerms(terms);
  const ordered: Record<string, unknown> = {
    amount_usd: terms.amount_usd,
  };
  if (terms.assignment_agreement_sha256 !== undefined) {
    ordered.assignment_agreement_sha256 = terms.assignment_agreement_sha256;
  }
  ordered.claim_account = terms.claim_account;
  ordered.clauses = terms.clauses;
  ordered.debtor_key = terms.debtor_key;
  ordered.debtor_legal_name = terms.debtor_legal_name;
  ordered.due_date = terms.due_date;
  ordered.invoice_number = terms.invoice_number;
  ordered.issuer_account = terms.issuer_account;
  ordered.issuer_legal_name = terms.issuer_legal_name;
  ordered.line_items_sha256 = terms.line_items_sha256;
  ordered.pay_link = terms.pay_link;
  ordered.schema = terms.schema;
  return JSON.stringify(ordered);
}

export function termsHash(terms: Terms): string {
  return sha256Hex0x(canonicalTerms(terms));
}
