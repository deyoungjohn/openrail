// Pure money-in logic for the dashboard cards and tables. Every figure comes from receipts (what was booked),
// never from invoice amounts. Money is bigint cents; nothing is rounded up.

export type Stream = "invoice" | "checkout" | "pay_link";
export const STREAMS: readonly Stream[] = ["invoice", "checkout", "pay_link"];

export interface InvoiceLike {
  id: string;
  invoice_number: string;
  debtor_legal_name: string;
  /** Present once checkouts and pay links exist; every invoice from the API is an invoice. */
  stream?: Stream;
}

export interface ReceiptLike {
  id: string;
  invoice_id: string;
  amount: string;
  asset: string;
  time: string;
  /** Absent until the receipt is verified against the origin chain; the asset still says which chain it came from. */
  origin_tx?: { chain?: string; hash?: string; sender?: string } | null;
  booking_tx_hash: string;
}

export interface Earning {
  id: string;
  /** Epoch milliseconds. */
  time: number;
  cents: bigint;
  payer: string;
  product: string;
  stream: Stream;
  chain: string;
  txHash: string;
  invoiceId: string;
}

const DAY_MS = 86_400_000;
const KNOWN_TIME_FROM = Date.UTC(2001, 0, 1);

const ASSET_CHAIN: [string, string][] = [
  ["base-", "base"],
  ["arb-", "arbitrum"],
  ["eth-", "ethereum"],
  ["op-", "optimism"],
  ["polygon-", "polygon"],
  ["pol-", "polygon"],
  ["bsc-", "bnb"],
  ["bnb-", "bnb"],
  ["sol-", "solana"],
];

/** The chain the money came from: the verified origin transaction when there is one, else read from the asset. */
export function chainOfReceipt(r: Pick<ReceiptLike, "asset" | "origin_tx">): string {
  const verified = r.origin_tx?.chain;
  if (verified) return verified;
  const id = r.asset.replace(/^nep\d+:/, "");
  return ASSET_CHAIN.find(([prefix]) => id.startsWith(prefix))?.[1] ?? "near";
}

/** USDC base units (6 decimals) to whole cents, the sub-cent part dropped. */
export const unitsToCents = (units: bigint): bigint => units / 10_000n;

export function earningsFrom(
  invoices: readonly InvoiceLike[],
  receipts: Readonly<Record<string, readonly ReceiptLike[]>>,
): Earning[] {
  const out: Earning[] = [];
  for (const inv of invoices) {
    const stream = inv.stream ?? "invoice";
    for (const r of receipts[inv.id] ?? []) {
      const parsed = Date.parse(r.time);
      if (!Number.isFinite(parsed)) continue;
      // A time before 2001 cannot be real (the indexer once stored 1970): keep the payment, say its time is
      // unknown (0) and leave it out of every figure that depends on when.
      const time = parsed < KNOWN_TIME_FROM ? 0 : parsed;
      const sender = r.origin_tx?.sender;
      out.push({
        id: r.id,
        time,
        cents: unitsToCents(BigInt(r.amount)),
        payer:
          stream === "invoice"
            ? inv.debtor_legal_name
            : sender
              ? `${sender.slice(0, 6)}…${sender.slice(-4)}`
              : "Anonymous",
        product: stream === "invoice" ? `Invoice ${inv.invoice_number}` : inv.invoice_number,
        stream,
        chain: chainOfReceipt(r),
        txHash: r.booking_tx_hash,
        invoiceId: inv.id,
      });
    }
  }
  return out.sort((a, b) => b.time - a.time);
}

const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);

export interface RevenueSummary {
  currentCents: bigint;
  previousCents: bigint;
  /** Percent change against last month, or null when last month had nothing. */
  deltaPct: number | null;
  /** Eight weekly totals ending now, oldest first (for the sparkline). */
  series: number[];
}

export function revenueSummary(earnings: readonly Earning[], nowMs: number): RevenueSummary {
  const now = new Date(nowMs);
  const cur = monthKey(nowMs);
  const prev = monthKey(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  let currentCents = 0n;
  let previousCents = 0n;
  const series = Array.from({ length: 8 }, () => 0);
  for (const e of earnings) {
    const m = monthKey(e.time);
    if (m === cur) currentCents += e.cents;
    else if (m === prev) previousCents += e.cents;
    const weeksAgo = Math.floor((nowMs - e.time) / (7 * DAY_MS));
    if (weeksAgo >= 0 && weeksAgo < 8)
      series[7 - weeksAgo] = (series[7 - weeksAgo] ?? 0) + Number(e.cents) / 100;
  }
  const deltaPct =
    previousCents === 0n
      ? null
      : Number(((currentCents - previousCents) * 1000n) / previousCents) / 10;
  return { currentCents, previousCents, deltaPct, series };
}

/** Payments per day for the last seven days, oldest first, with the weekday letter of each day. */
export function lastSevenDays(
  earnings: readonly Earning[],
  nowMs: number,
): { label: string; count: number }[] {
  const startOfToday = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const days = Array.from({ length: 7 }, (_, i) => {
    const at = startOfToday - (6 - i) * DAY_MS;
    return { at, label: "SMTWTFS"[new Date(at).getUTCDay()] ?? "", count: 0 };
  });
  for (const e of earnings) {
    const d = days.find((x) => e.time >= x.at && e.time < x.at + DAY_MS);
    if (d) d.count += 1;
  }
  return days.map(({ label, count }) => ({ label, count }));
}

export interface OverviewRow {
  key: "payments" | "average" | "received";
  value: bigint;
  /** Percent change against the 30 days before, or null when there is nothing to compare. */
  deltaPct: number | null;
}

/** Last 30 days against the 30 days before: number of payments, average payment, money received. */
export function overview(earnings: readonly Earning[], nowMs: number): OverviewRow[] {
  const split = (from: number, to: number) => {
    let n = 0n;
    let sum = 0n;
    for (const e of earnings)
      if (e.time > from && e.time <= to) {
        n += 1n;
        sum += e.cents;
      }
    return { n, sum, avg: n === 0n ? 0n : sum / n };
  };
  const now = split(nowMs - 30 * DAY_MS, nowMs);
  const before = split(nowMs - 60 * DAY_MS, nowMs - 30 * DAY_MS);
  const pct = (a: bigint, b: bigint): number | null =>
    b === 0n ? null : Number(((a - b) * 1000n) / b) / 10;
  return [
    { key: "payments", value: now.n, deltaPct: pct(now.n, before.n) },
    { key: "average", value: now.avg, deltaPct: pct(now.avg, before.avg) },
    { key: "received", value: now.sum, deltaPct: pct(now.sum, before.sum) },
  ];
}

export function topPayers(
  earnings: readonly Earning[],
  limit = 3,
): { name: string; cents: bigint }[] {
  const m = new Map<string, bigint>();
  for (const e of earnings) m.set(e.payer, (m.get(e.payer) ?? 0n) + e.cents);
  return [...m]
    .map(([name, cents]) => ({ name, cents }))
    .sort((a, b) =>
      a.cents === b.cents ? a.name.localeCompare(b.name) : a.cents > b.cents ? -1 : 1,
    )
    .slice(0, limit);
}

export function byStream(earnings: readonly Earning[]): { stream: Stream; cents: bigint }[] {
  const m = new Map<Stream, bigint>();
  for (const e of earnings) m.set(e.stream, (m.get(e.stream) ?? 0n) + e.cents);
  return STREAMS.map((stream) => ({ stream, cents: m.get(stream) ?? 0n }));
}

export function byMonth(earnings: readonly Earning[]): { month: string; cents: bigint }[] {
  const m = new Map<string, bigint>();
  for (const e of earnings) {
    if (e.time === 0) continue;
    m.set(monthKey(e.time), (m.get(monthKey(e.time)) ?? 0n) + e.cents);
  }
  return [...m]
    .map(([month, cents]) => ({ month, cents }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

export function byChain(
  earnings: readonly Earning[],
): { chain: string; cents: bigint; count: number }[] {
  const m = new Map<string, { cents: bigint; count: number }>();
  for (const e of earnings) {
    const cur = m.get(e.chain) ?? { cents: 0n, count: 0 };
    m.set(e.chain, { cents: cur.cents + e.cents, count: cur.count + 1 });
  }
  return [...m]
    .map(([chain, v]) => ({ chain, ...v }))
    .sort((a, b) =>
      a.cents === b.cents ? a.chain.localeCompare(b.chain) : a.cents > b.cents ? -1 : 1,
    );
}

export type TimeRange = "all" | "7d" | "30d" | "90d";

/** Whether a time falls inside the range that ends now. */
export function inTimeRange(ms: number, range: TimeRange, nowMs: number): boolean {
  if (range === "all") return true;
  if (ms === 0) return false;
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return ms > nowMs - days * DAY_MS && ms <= nowMs + DAY_MS;
}

/** A range of calendar days (UTC, `YYYY-MM-DD`, both ends included); `to` may be missing while the end is being chosen. */
export interface DayRange {
  from: string;
  to?: string;
}

/** Whether a time falls inside the days chosen; no range means every time, and an unknown time never matches a range. */
export function inDayRange(ms: number, range: DayRange | null): boolean {
  if (range === null) return true;
  if (ms === 0) return false;
  const day = new Date(ms).toISOString().slice(0, 10);
  return day >= range.from && day <= (range.to ?? range.from);
}
