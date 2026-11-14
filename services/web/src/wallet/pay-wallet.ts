"use client";

import type { Route } from "@openrail/api-client";
import type { Address } from "viem";
import { useEvm } from "./evm";
import { useNear } from "./near";
import { nearTokenPayment } from "./near-pay";
import { KNOWN_SOLANA_WALLETS, useSolana } from "./solana";
import { walletKindOf, type PayWalletKind } from "./wallet-kind";

export interface PayWallet {
  kind: PayWalletKind | null;
  /** The address of the connected wallet of THIS route's chain family, never one of another. */
  address: string | null;
  /** A way to connect a wallet exists for this route. */
  available: boolean;
  error: boolean;
  /** The wallets in this browser the payer can pick from (EVM and Solana; empty for NEAR, which has its own picker). */
  choices: { id: string; name: string; icon: string }[];
  /** Wallets the page knows but this browser does not have (Solana), shown as not installed. */
  missing: { id: string; name: string }[];
  /** The name of the connected wallet, when known. */
  walletName: string | null;
  /** Connects the wallet of the route's chain family (the picked one, for EVM). */
  connect: (id?: string) => void;
  disconnect: () => void;
  /** Sends `amount` (the origin asset's base units) to `to` from the connected wallet; returns the hash. */
  pay: (to: string, amount: bigint) => Promise<string>;
}

const NONE: PayWallet = {
  kind: null,
  address: null,
  available: false,
  error: false,
  choices: [],
  missing: [],
  walletName: null,
  connect: () => undefined,
  disconnect: () => undefined,
  pay: async () => {
    throw new Error("wallet_not_available");
  },
};

/**
 * The wallet to pay a route from, the browser's own for each family: an injected EVM wallet, an injected Solana
 * wallet, or the NEAR wallet the site connects. No WalletConnect: it made the pay page heavy and slow (13 Nov).
 */
export function usePayWallet(route: Route | null): PayWallet {
  const evm = useEvm();
  const sol = useSolana();
  const near = useNear();
  const kind = walletKindOf(route);
  if (route === null || kind === null) return NONE;

  if (kind === "near")
    return {
      kind,
      address: near.accountId,
      available: near.ready,
      error: near.error,
      choices: [],
      missing: [],
      walletName: null,
      connect: () => near.signIn(),
      disconnect: () => void near.signOut(),
      pay: async (to, amount) => {
        const hash = await near.callBatch(
          route.origin_contract as string,
          nearTokenPayment(to, amount, route.origin_contract as string, near.accountId ?? ""),
        );
        if (hash === undefined) throw new Error("wallet_no_hash");
        return hash;
      },
    };

  if (kind === "solana")
    return {
      kind,
      address: sol.address,
      available: sol.available,
      error: sol.error,
      choices: sol.wallets.map(({ id, name }) => ({ id, name, icon: "" })),
      missing: KNOWN_SOLANA_WALLETS.filter((k) => !sol.wallets.some((w) => w.id === k.id)),
      walletName: sol.connectedName,
      connect: (id) => void sol.connect(id),
      disconnect: sol.disconnect,
      pay: (to, amount) =>
        sol.pay({
          to,
          mint: route.origin_contract as string,
          amount,
          decimals: route.origin_decimals,
        }),
    };

  return {
    kind,
    address: evm.address,
    available: evm.available,
    error: evm.error,
    choices: evm.wallets.map(({ id, name, icon }) => ({ id, name, icon })),
    missing: [],
    walletName: evm.connectedName,
    connect: (id) => void evm.connect(id),
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
