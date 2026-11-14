import type { Route } from "@openrail/api-client";
import { chainOfRoute } from "../lib/pay";

export type PayWalletKind = "evm" | "solana" | "near";

/**
 * The chain family a route is paid from, or null when no wallet can send it here (the native coin of Solana). NEAR
 * tokens are sent from the NEAR wallet the site already connects (the one used to sign in).
 */
export function walletKindOf(route: Route | null): PayWalletKind | null {
  if (route === null) return null;
  const chain = chainOfRoute(route);
  if (chain === "near") return route.origin_contract === null ? null : "near";
  if (chain === "solana") return route.origin_contract === null ? null : "solana";
  return route.evm_chain_id !== null ? "evm" : null;
}
