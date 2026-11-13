/** Where a merchant's money is: one row per held share, followed from the booking to the private balance. */

export type TrailStage = "held" | "sending" | "private" | "returned" | "withdrawn";

export interface TrailRow {
  key: string;
  tokenId: string;
  index: number;
  /** USDC base units. */
  amount: bigint;
  stage: TrailStage;
  /** Epoch ms of the latest step. */
  time: number;
  /** The NEAR transaction that closed the step (the settle hash or the refund), when there is one. */
  tx: string | null;
  /** A withdrawal: the provider's word, where it went, and the explorer link of the payout transaction. */
  withdrawal?: {
    status: string;
    chain: string;
    address: string;
    hashes: string[];
    urls: string[];
  };
}

export interface WithdrawalJson {
  deposit_address: string;
  amount: string;
  destination_chain: string;
  address: string;
  created_at: string;
  updated_at?: string;
  status: string;
  destination_tx_hashes: string[];
  destination_explorer_urls: string[];
}

/** One row per withdrawal started on this site: money leaving the private balance. */
export function withdrawalRows(list: readonly WithdrawalJson[]): TrailRow[] {
  return list.map((w) => ({
    key: `w:${w.deposit_address}`,
    tokenId: "",
    index: 0,
    amount: /^\d+$/.test(w.amount) ? BigInt(w.amount) : 0n,
    stage: "withdrawn" as const,
    time: Date.parse(w.updated_at ?? w.created_at) || Date.parse(w.created_at) || 0,
    tx: null,
    withdrawal: {
      status: w.status,
      chain: w.destination_chain,
      address: w.address,
      hashes: w.destination_tx_hashes,
      urls: w.destination_explorer_urls,
    },
  }));
}

export interface TrailEvent {
  id: string;
  type: string;
  created: number;
  data: Record<string, unknown>;
}

const ORDER: Record<string, number> = {
  settle_held: 1,
  settle_sent: 2,
  settle_settled: 3,
  settle_refunded: 3,
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v)
    ? v
    : typeof v === "string" && /^\d+$/.test(v)
      ? Number(v)
      : null;

/** Rebuild the rows from the settle events, newest first. An event that is out of order never moves a row back. */
export function buildTrail(events: readonly TrailEvent[]): TrailRow[] {
  const rows = new Map<string, TrailRow & { rank: number }>();
  for (const e of [...events].sort((a, b) => a.created - b.created)) {
    const rank = ORDER[e.type];
    if (rank === undefined) continue;
    const tokenId = typeof e.data.token_id === "string" ? e.data.token_id : "";
    const index = num(e.data.index);
    if (tokenId === "" || index === null) continue;
    const key = `${tokenId}#${index}`;
    const prev = rows.get(key);
    const amountText =
      e.type === "settle_held" ? e.data.amount : (e.data.amount_in ?? e.data.amount);
    const amount =
      typeof amountText === "string" && /^\d+$/.test(amountText)
        ? BigInt(amountText)
        : (prev?.amount ?? 0n);
    if (prev !== undefined && rank < prev.rank) continue;
    const stage: TrailStage =
      e.type === "settle_held"
        ? "held"
        : e.type === "settle_sent"
          ? "sending"
          : e.type === "settle_settled"
            ? "private"
            : "returned";
    const tx =
      typeof e.data.destination_tx === "string" && e.data.destination_tx !== ""
        ? e.data.destination_tx
        : (prev?.tx ?? null);
    rows.set(key, {
      key,
      tokenId,
      index,
      amount:
        prev !== undefined && e.type !== "settle_held" && amount === 0n ? prev.amount : amount,
      stage,
      time: e.created * 1000,
      tx,
      rank,
    });
  }
  return [...rows.values()]
    .map((r) => ({
      key: r.key,
      tokenId: r.tokenId,
      index: r.index,
      amount: r.amount,
      stage: r.stage,
      time: r.time,
      tx: r.tx,
    }))
    .sort((a, b) => b.time - a.time);
}

export interface TrailTotals {
  held: bigint;
  sending: bigint;
  private: bigint;
  returned: bigint;
  /** Withdrawn from the private balance (SUCCESS only). */
  withdrawn: bigint;
}

export function trailTotals(rows: readonly TrailRow[]): TrailTotals {
  const t: TrailTotals = { held: 0n, sending: 0n, private: 0n, returned: 0n, withdrawn: 0n };
  for (const r of rows) {
    if (r.stage === "withdrawn" && r.withdrawal?.status !== "SUCCESS") continue;
    t[r.stage] += r.amount;
  }
  return t;
}
