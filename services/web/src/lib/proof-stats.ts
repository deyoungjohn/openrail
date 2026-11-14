import type { ProofRow } from "./proof-data";

export interface ProofStats {
  /** Sum of every booked payment, in US dollars. */
  processedUsd: number;
  /** Payments booked by the contract (invoice payments and paid checkouts). */
  payments: number;
  /** Invoices issued and checkouts opened or paid (each is one NFT). */
  requests: number;
  /** The average booked payment, in US dollars (0 when there is none). */
  averageUsd: number;
}

const PAID: readonly string[] = ["Checkout paid", "Invoice payment booked"];

/** The headline numbers, added up from the Proof rows (the demo business's transactions on NEAR mainnet). */
export function proofStats(rows: readonly ProofRow[]): ProofStats {
  const paid = rows.filter((r) => PAID.includes(r.type));
  const cents = paid.reduce((n, r) => n + Math.round(Number(r.amount_usd) * 100), 0);
  const requests = new Set(
    rows
      .filter((r) => r.type !== "Late payment refunded" && r.type !== "Invoice payment booked")
      .map((r) => r.claim),
  ).size;
  return {
    processedUsd: cents / 100,
    payments: paid.length,
    requests,
    averageUsd: paid.length === 0 ? 0 : cents / 100 / paid.length,
  };
}
