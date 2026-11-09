// What the cash-out page shows about a cash-out: the token it is taken from, where it is on its way, and the money
// figures of a time frame. Money is bigint; cents are cut, never rounded up. Nothing here is ever negative.

import type { Earning } from "./earnings";

export interface CashoutRow {
  id: string;
  amount: string;
  amount_out: string;
  source_asset: string;
  destination_chain: string;
  destination_address: string;
  route_cost_usd: string;
  created_at: string;
  deadline: string;
  tx_hash: string | null;
  tx_state: string | null;
  status: string;
  provider_status: string | null;
  near_tx_hashes: string[];
  destination_tx_hashes: string[];
}

/** USDC base units to whole cents, cut. */
export const unitsToCents = (units: string | bigint): bigint => BigInt(units) / 10_000n;

const NETWORK_WORD: Record<string, string> = {
  base: "BASE",
  arb: "ARB",
  arbitrum: "ARB",
  op: "OP",
  optimism: "OP",
  pol: "POL",
  polygon: "POL",
  eth: "ETH",
  ethereum: "ETH",
  sol: "SOL",
  solana: "SOL",
  bsc: "BNB",
  bnb: "BNB",
};

/** `nep141:base-0x8335….omft.near` is `BASE USDC`; the NEAR token is `NEAR USDC`. All the tokens held here are USDC. */
export function tokenLabel(tokenId: string): string {
  const id = tokenId.replace(/^nep\d+:/, "");
  const prefix = /^([a-z]+)-/.exec(id)?.[1];
  const network = prefix ? (NETWORK_WORD[prefix] ?? prefix.toUpperCase()) : "NEAR";
  return `${network} USDC`;
}

/** A cash-out that still counts as money taken out: it is on its way or has arrived, not refunded or failed. */
export const isCashedOut = (c: Pick<CashoutRow, "status">): boolean =>
  c.status === "success" || c.status === "processing" || c.status === "sent";

/** No more changes to wait for. */
export const isFinished = (c: Pick<CashoutRow, "status">): boolean =>
  c.status === "success" ||
  c.status === "refunded" ||
  c.status === "failed" ||
  c.status === "incomplete" ||
  c.status === "expired";

export type StepStatus = "done" | "current" | "todo" | "failed";
export interface FlowStep {
  id: "balance" | "bridge" | "sending" | "arrived";
  status: StepStatus;
}

/**
 * The four stops of a cash-out: out of the balance on `intents.near`, received by the bridge, sent on to the other
 * network, arrived. The first is confirmed by the chain (the transaction the merchant signed), the others by the
 * provider. A cash-out that was refunded, failed or is short of its deposit stops at the stop it never passed.
 */
export function flowSteps(c: Pick<CashoutRow, "status" | "tx_state" | "tx_hash">): FlowStep[] {
  const steps = (a: StepStatus, b: StepStatus, c2: StepStatus, d: StepStatus): FlowStep[] => [
    { id: "balance", status: a },
    { id: "bridge", status: b },
    { id: "sending", status: c2 },
    { id: "arrived", status: d },
  ];
  switch (c.status) {
    case "success":
      return steps("done", "done", "done", "done");
    case "processing":
      return steps("done", "done", "current", "todo");
    case "sent":
      return c.tx_state === "success"
        ? steps("done", "current", "todo", "todo")
        : steps("current", "todo", "todo", "todo");
    case "incomplete":
      return steps("done", "failed", "todo", "todo");
    case "refunded":
      return steps("done", "done", "failed", "todo");
    case "failed":
      return c.tx_state === "failed"
        ? steps("failed", "todo", "todo", "todo")
        : steps("done", "done", "failed", "todo");
    default:
      // quoted, expired: nothing has left the balance
      return steps("todo", "todo", "todo", "todo");
  }
}

export interface Window {
  from: number;
  to: number;
}

export interface CashoutFigures {
  revenueCents: bigint;
  cashedOutCents: bigint;
  /** Revenue not cashed out yet in this window, never below zero. */
  keptCents: bigint;
}

const inWindow = (ms: number, w: Window) => ms >= w.from && ms < w.to;

export function figures(
  earnings: readonly Earning[],
  cashouts: readonly CashoutRow[],
  w: Window,
): CashoutFigures {
  let revenueCents = 0n;
  for (const e of earnings) if (inWindow(e.time, w)) revenueCents += e.cents > 0n ? e.cents : 0n;
  let cashedOutCents = 0n;
  for (const c of cashouts)
    if (isCashedOut(c) && inWindow(Date.parse(c.created_at), w))
      cashedOutCents += unitsToCents(c.amount);
  const kept = revenueCents - cashedOutCents;
  return { revenueCents, cashedOutCents, keptCents: kept > 0n ? kept : 0n };
}

export interface MonthBar {
  /** `2026-11` */
  month: string;
  /** Short label, for example `Nov`. */
  label: string;
  revenue: number;
  cashedOut: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The last `count` months, oldest first, in dollars. Both series are zero or more. */
export function monthBars(
  earnings: readonly Earning[],
  cashouts: readonly CashoutRow[],
  nowMs: number,
  count = 6,
): MonthBar[] {
  const now = new Date(nowMs);
  const bars: MonthBar[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    bars.push({
      month: d.toISOString().slice(0, 7),
      label: MONTHS[d.getUTCMonth()] ?? "",
      revenue: 0,
      cashedOut: 0,
    });
  }
  const at = (ms: number) => bars.find((b) => b.month === new Date(ms).toISOString().slice(0, 7));
  for (const e of earnings) {
    const bar = at(e.time);
    if (bar && e.cents > 0n) bar.revenue += Number(e.cents) / 100;
  }
  for (const c of cashouts) {
    const bar = at(Date.parse(c.created_at));
    if (bar && isCashedOut(c)) bar.cashedOut += Number(unitsToCents(c.amount)) / 100;
  }
  return bars;
}
