"use client";

/** The light half of the wallet connector: its state shape and hook. The heavy provider (WalletConnect, wagmi, Solana) is in `connector.tsx` and loads only on the pay pages. */
import { createContext, useContext } from "react";
import type { Address, Hex } from "viem";

export const PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
export const connectorEnabled = PROJECT_ID !== "";

export type Namespace = "eip155" | "solana";

export interface ConnectorState {
  enabled: boolean;
  evmAddress: string | null;
  solAddress: string | null;
  /** Opens the connect dialog for one chain family. */
  open: (ns: Namespace) => void;
  disconnect: (ns: Namespace) => Promise<void>;
  payEvm: (request: {
    chainId: number;
    to: Address;
    amount: bigint;
    token: Address | null;
  }) => Promise<Hex>;
  paySolana: (request: {
    to: string;
    mint: string;
    amount: bigint;
    decimals: number;
  }) => Promise<string>;
}

const OFF: ConnectorState = {
  enabled: false,
  evmAddress: null,
  solAddress: null,
  open: () => undefined,
  disconnect: async () => undefined,
  payEvm: async () => {
    throw new Error("wallet_not_connected");
  },
  paySolana: async () => {
    throw new Error("wallet_not_connected");
  },
};

export const ConnectorCtx = createContext<ConnectorState>(OFF);
export const useConnector = (): ConnectorState => useContext(ConnectorCtx);
