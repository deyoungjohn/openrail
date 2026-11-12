"use client";

import type { Route } from "@openrail/api-client";
import type { Address } from "viem";
import { useConnector } from "./connector";
import { useEvm } from "./evm";
import { walletKindOf, type PayWalletKind } from "./wallet-kind";

export interface PayWallet {
  kind: PayWalletKind | null;
  /** The address of the connected wallet of THIS route's chain family, never one of another. */
  address: string | null;
  /** A way to connect a wallet exists for this route. */
  available: boolean;
  error: boolean;
  /** Opens the wallet dialog for the route's chain family. */
  connect: () => void;
  disconnect: () => void;
  /** Sends `amount` (the origin asset's base units) to `to` from the connected wallet; returns the hash. */
  pay: (to: string, amount: bigint) => Promise<string>;
}

/**
 * The wallet to pay a route from. With a WalletConnect project id it is the connector, which connects the chain family
 * the person picked (Solana for a Solana route, never an EVM address that was cached for another one). Without it the
 * browser's own EVM wallet is used, for EVM routes only.
 */
export function usePayWallet(route: Route | null): PayWallet {
  const connector = useConnector();
  const evm = useEvm();
  const kind = walletKindOf(route);

  if (route === null || kind === null) {
    return {
      kind: null,
      address: null,
      available: false,
      error: false,
      connect: () => undefined,
      disconnect: () => undefined,
      pay: async () => {
        throw new Error("wallet_not_available");
      },
    };
  }

  if (connector.enabled) {
    const ns = kind === "solana" ? "solana" : "eip155";
    return {
      kind,
      address: kind === "solana" ? connector.solAddress : connector.evmAddress,
      available: true,
      error: false,
      connect: () => connector.open(ns),
      disconnect: () => void connector.disconnect(ns),
      pay: (to, amount) =>
        kind === "solana"
          ? connector.paySolana({
              to,
              mint: route.origin_contract as string,
              amount,
              decimals: route.origin_decimals,
            })
          : connector.payEvm({
              chainId: route.evm_chain_id as number,
              to: to as Address,
              amount,
              token: route.origin_contract === null ? null : (route.origin_contract as Address),
            }),
    };
  }

  // No connector: the browser's own wallet, EVM only.
  return {
    kind,
    address: kind === "evm" ? evm.address : null,
    available: kind === "evm" && evm.available,
    error: evm.error,
    connect: () => void evm.connect(),
    disconnect: evm.disconnect,
    pay: (to, amount) =>
      evm.pay({
        chainId: route.evm_chain_id as number,
        to: to as Address,
        amount,
        token: route.origin_contract === null ? null : (route.origin_contract as Address),
      }),
  };
}
