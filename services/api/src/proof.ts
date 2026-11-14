/**
 * The rows of the public Proof page, from one business's indexed events (expanded through the enabled modules):
 * every row is a transaction on NEAR anyone can open on the explorer. Nothing private is in a row: no names, no
 * payer addresses, only the kind, the amount, the claim's own account, the transaction and its time.
 */
export interface ProofRow {
  type:
    | "Invoice issued"
    | "Invoice payment booked"
    | "Checkout opened"
    | "Checkout paid"
    | "Late payment refunded";
  amount_usd: string;
  claim: string;
  tx: string;
  time: number;
}

/** USDC base units (6 decimals) as dollars and cents, rounded to the nearest cent. */
function usdOfUnits(value: unknown): string | null {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!/^\d+$/.test(text)) return null;
  const cents = (BigInt(text) + 5_000n) / 10_000n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function usdText(value: unknown): string | null {
  return typeof value === "string" && /^\d+\.\d{2}$/.test(value) ? value : null;
}

const CHECKOUT: Record<string, ProofRow["type"]> = {
  "checkout.created": "Checkout opened",
  "checkout.paid": "Checkout paid",
  "checkout.refund_started": "Late payment refunded",
};

export function proofRows(
  events: readonly Record<string, unknown>[],
  root: string,
  limit = 50,
): ProofRow[] {
  const tokenOf = (e: Record<string, unknown>) => {
    const t = (e.data as { token_id?: unknown } | undefined)?.token_id;
    return typeof t === "string" ? t : "";
  };
  // A checkout's own (module) events tell its story; its raw issue/booked would repeat them as an "invoice".
  const checkouts = new Set(
    events.filter((e) => String(e.type).startsWith("checkout.")).map(tokenOf),
  );
  const rows: ProofRow[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    const token = tokenOf(e);
    const tx = typeof data.tx_hash === "string" ? data.tx_hash : "";
    const time = typeof e.created === "number" ? e.created : 0;
    if (token === "" || tx === "") continue;
    let type: ProofRow["type"] | undefined;
    let amount: string | null = null;
    if (CHECKOUT[String(e.type)] !== undefined) {
      type = CHECKOUT[String(e.type)];
      amount = usdText(data.total_usd) ?? usdText(data.amount_usd);
    } else if (!checkouts.has(token) && e.type === "issue") {
      type = "Invoice issued";
      amount = usdOfUnits(data.amount_due);
    } else if (!checkouts.has(token) && e.type === "booked") {
      type = "Invoice payment booked";
      amount = usdOfUnits(data.payment);
    }
    if (type === undefined || amount === null) continue;
    const key = `${type}:${tx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ type, amount_usd: amount, claim: `${token}.${root}`, tx, time });
  }
  rows.sort((a, b) => b.time - a.time);
  return rows.slice(0, limit);
}
