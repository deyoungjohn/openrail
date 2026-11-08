/** Exact invoice line items and the platform fee arithmetic, all in cents. */
import { sha256Hex0x } from "./crypto.js";

export const PROCESSING_FEE_DESCRIPTION = "Processing fee (0.25%)";
export type FeeMode = "absorb" | "pass_to_customer";

export interface LineItem {
  description: string;
  quantity: number;
  unit_amount_usd: string;
  amount_usd: string;
}

function centsOf(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (match === null) throw new Error("invalid money");
  const cents = (match[2] ?? "").padEnd(2, "0");
  return BigInt(match[1] ?? "0") * 100n + BigInt(cents);
}

function usdOf(cents: bigint): string {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

export function normalizeLineItems(input: unknown): LineItem[] {
  if (!Array.isArray(input)) throw new Error("line_items must be a list");
  if (input.length > 100) throw new Error("line_items must have at most 100 rows");
  return input.map((entry) => {
    const row = entry as { description?: unknown; quantity?: unknown; unit_amount_usd?: unknown };
    if (typeof row.description !== "string" || row.description.trim() === "")
      throw new Error("line item description required");
    if (!Number.isSafeInteger(row.quantity) || (row.quantity as number) <= 0)
      throw new Error("line item quantity must be a positive integer");
    if (typeof row.unit_amount_usd !== "string")
      throw new Error("line item unit_amount_usd required");
    const unitCents = centsOf(row.unit_amount_usd);
    return {
      description: row.description,
      quantity: row.quantity as number,
      unit_amount_usd: usdOf(unitCents),
      amount_usd: usdOf(unitCents * BigInt(row.quantity as number)),
    };
  });
}

/** The browser canonical form: JSON.stringify(items) with the four fields in this order. */
export const lineItemsFingerprint = (items: readonly LineItem[]): string =>
  sha256Hex0x(JSON.stringify(items));

export function processingFeeCents(subtotalUsd: string): bigint {
  const subtotal = centsOf(subtotalUsd);
  return (subtotal * 25n + 9999n) / 10000n;
}

export function feeLineItem(subtotalUsd: string): LineItem {
  const fee = usdOf(processingFeeCents(subtotalUsd));
  return {
    description: PROCESSING_FEE_DESCRIPTION,
    quantity: 1,
    unit_amount_usd: fee,
    amount_usd: fee,
  };
}

export function resolveFee(
  subtotalUsd: string,
  items: readonly LineItem[],
  mode: FeeMode,
): { items: LineItem[]; amountUsd: string; feeUsd: string } {
  const subtotal = centsOf(subtotalUsd);
  if (mode === "absorb") {
    return { items: [...items], amountUsd: usdOf(subtotal), feeUsd: "0.00" };
  }
  const fee = processingFeeCents(subtotalUsd);
  return {
    items: [...items, feeLineItem(subtotalUsd)],
    amountUsd: usdOf(subtotal + fee),
    feeUsd: usdOf(fee),
  };
}

export function feePreview(subtotalUsd: string, mode: FeeMode) {
  const subtotal = centsOf(subtotalUsd);
  const fee = mode === "pass_to_customer" ? processingFeeCents(subtotalUsd) : 0n;
  return {
    subtotal_usd: usdOf(subtotal),
    fee_usd: usdOf(fee),
    total_usd: usdOf(subtotal + fee),
    merchant_receives_usd: usdOf(subtotal),
    fee_mode: mode,
  };
}
