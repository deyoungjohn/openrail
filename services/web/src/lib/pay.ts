import type { ChainId } from "../components/ui/chain-badge";
import { copy } from "../copy";

// Pure view logic for the pay page (blueprint 2.8). No React, no network.

export interface RouteLike {
  id: string;
  origin_chain: string;
  payer_asset: string;
  origin_decimals: number;
  swap_type: "FLEX_INPUT" | "EXACT_OUTPUT";
}

const CHAINS: readonly ChainId[] = [
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "bnb",
  "solana",
  "near",
];

/** The badge for a route's origin chain, or null when the UI has none (never a wrong one). */
export const chainOfRoute = (r: Pick<RouteLike, "origin_chain">): ChainId | null =>
  CHAINS.find((c) => c === r.origin_chain) ?? null;

/**
 * An integer amount in base units as a decimal string. Nothing is rounded: every digit is kept,
 * trailing zeros are trimmed down to at least two decimals ("12.50").
 */
export function formatToken(units: string, decimals: number): string {
  const n = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const whole = (n / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (n % base).toString().padStart(decimals, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${frac}`;
}

/** Price-protection margin in basis points as a percent with two decimals. */
export const spreadLabel = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

/** USDC routes send exactly the amount due; ETH and SOL routes say "you pay up to" (2.8). */
export const amountPrefix = (r: Pick<RouteLike, "swap_type">): "exact" | "upto" =>
  r.swap_type === "EXACT_OUTPUT" ? "upto" : "exact";

export type PayStatus = "pending_deposit" | "processing" | "success" | "refunded" | "failed";
export type PayStage = "waiting" | "expired" | "processing" | "paid" | "refunded" | "failed";

/** An expired quote is never reused; money already in flight keeps its own stage. */
export function payStage(status: PayStatus, deadlineIso: string, nowMs: number): PayStage {
  switch (status) {
    case "pending_deposit":
      return Date.parse(deadlineIso) <= nowMs ? "expired" : "waiting";
    case "processing":
      return "processing";
    case "success":
      return "paid";
    case "refunded":
      return "refunded";
    case "failed":
      return "failed";
  }
}

export interface PayStep {
  id: "sent" | "received" | "paid";
  status: "done" | "current" | "todo" | "failed";
}

export function payTimeline(stage: PayStage): PayStep[] {
  const steps = (a: PayStep["status"], b: PayStep["status"], c: PayStep["status"]): PayStep[] => [
    { id: "sent", status: a },
    { id: "received", status: b },
    { id: "paid", status: c },
  ];
  switch (stage) {
    case "waiting":
    case "expired":
      return steps("current", "todo", "todo");
    case "processing":
      return steps("done", "current", "todo");
    case "paid":
      return steps("done", "done", "done");
    case "refunded":
    case "failed":
      return steps("done", "failed", "todo");
  }
}

const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/** An API date (`2026-12-01`) as `Dec 1, 2026`, in UTC so every viewer reads the same day. */
export const formatDueDate = (isoDate: string): string =>
  DATE.format(new Date(`${isoDate}T00:00:00Z`));

const EVM_CHAINS: readonly ChainId[] = [
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "bnb",
];
const NEAR_ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;

/**
 * A plain-words problem with a refund address on the route's origin chain, or null when it looks
 * right. The API validates per chain too (`invalid_refund_address`); this only saves a round trip.
 */
export function refundAddressProblem(chain: ChainId | null, value: string): string | null {
  const v = value.trim();
  if (chain !== null && EVM_CHAINS.includes(chain))
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? null : copy.pay.refundBad.evm;
  if (chain === "solana")
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? null : copy.pay.refundBad.solana;
  if (chain === "near")
    return NEAR_ACCOUNT.test(v) || /^[0-9a-f]{64}$/.test(v) ? null : copy.pay.refundBad.near;
  return copy.pay.refundBad.unknown;
}
