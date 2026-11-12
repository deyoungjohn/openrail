import type { Route } from "@openrail/api-client";
import { chainOfRoute } from "../lib/pay";

export type PayWalletKind = "evm" | "solana";

/** The chain family a route is paid from, or null when no wallet can send it (a native coin on Solana, NEAR). */
export function walletKindOf(route: Route | null): PayWalletKind | null {
  if (route === null) return null;
  const chain = chainOfRoute(route);
  if (chain === "solana") return route.origin_contract === null ? null : "solana";
  return route.evm_chain_id !== null ? "evm" : null;
}
