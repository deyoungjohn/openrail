"use client";

/**
 * Wallet connector for people who pay (not a sign-in): WalletConnect through Reown AppKit, for EVM chains and Solana.
 * It only connects a wallet to the chain the person picked so they can send the asset. No account, no email, no social
 * login, and nothing here signs anything but the payment the person approves in their own wallet.
 * Off (and the injected-wallet fallback stays) when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is not set.
 */
import {
  createAppKit,
  useAppKit,
  useAppKitAccount,
  useAppKitProvider,
  useDisconnect,
} from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import {
  arbitrum,
  base,
  bsc,
  mainnet,
  optimism,
  polygon,
  solana,
  type AppKitNetwork,
} from "@reown/appkit/networks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { WagmiProvider, type Config } from "wagmi";
import type { Address, EIP1193Provider, Hex } from "viem";
import { sendEvmPayment } from "./evm";
import { buildSolanaUsdcTransfer, SOLANA_RPC_URL } from "./solana-pay";

const PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
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

const Ctx = createContext<ConnectorState>(OFF);
export const useConnector = (): ConnectorState => useContext(Ctx);

const EVM_NETWORKS = [mainnet, base, arbitrum, optimism, polygon, bsc] as [
  AppKitNetwork,
  ...AppKitNetwork[],
];

let wagmiAdapter: WagmiAdapter | null = null;
let queryClient: QueryClient | null = null;

function setup(): { adapter: WagmiAdapter; client: QueryClient } | null {
  if (!connectorEnabled || typeof window === "undefined") return null;
  if (wagmiAdapter === null) {
    wagmiAdapter = new WagmiAdapter({ networks: EVM_NETWORKS, projectId: PROJECT_ID, ssr: true });
    queryClient = new QueryClient();
    createAppKit({
      adapters: [wagmiAdapter, new SolanaAdapter()],
      networks: [...EVM_NETWORKS, solana] as [AppKitNetwork, ...AppKitNetwork[]],
      projectId: PROJECT_ID,
      metadata: {
        name: "Openrail",
        description: "Pay an invoice or an order from the chain and the asset you hold.",
        url: window.location.origin,
        icons: [`${window.location.origin}/icon.png`],
      },
      // A connect dialog only: no accounts, no email, no social login, no analytics.
      features: { analytics: false, email: false, socials: false, onramp: false, swaps: false },
    });
  }
  return { adapter: wagmiAdapter, client: queryClient as QueryClient };
}

function Live({ children }: { children: ReactNode }) {
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const evm = useAppKitAccount({ namespace: "eip155" });
  const sol = useAppKitAccount({ namespace: "solana" });
  const evmProvider = useAppKitProvider<EIP1193Provider>("eip155");
  const solProvider = useAppKitProvider<{
    sendTransaction: (tx: unknown, connection: unknown) => Promise<string>;
  }>("solana");

  const value = useMemo<ConnectorState>(
    () => ({
      enabled: true,
      evmAddress: evm.isConnected ? (evm.address ?? null) : null,
      solAddress: sol.isConnected ? (sol.address ?? null) : null,
      open: (ns) => void open({ view: "Connect", namespace: ns }),
      disconnect: async (ns) => {
        await disconnect({ namespace: ns });
      },
      payEvm: async (request) => {
        const provider = evmProvider.walletProvider;
        const from = evm.address;
        if (!provider || !from) throw new Error("wallet_not_connected");
        return sendEvmPayment(provider, from as Address, request);
      },
      paySolana: async (request) => {
        const provider = solProvider.walletProvider;
        const from = sol.address;
        if (!provider || !from) throw new Error("wallet_not_connected");
        const { transaction, connection } = await buildSolanaUsdcTransfer({ from, ...request });
        return provider.sendTransaction(transaction, connection);
      },
    }),
    [
      evm.isConnected,
      evm.address,
      sol.isConnected,
      sol.address,
      open,
      disconnect,
      evmProvider.walletProvider,
      solProvider.walletProvider,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function ConnectorProvider({ children }: { children: ReactNode }) {
  const ready = setup();
  if (ready === null) return <>{children}</>;
  return (
    <WagmiProvider config={ready.adapter.wagmiConfig as Config}>
      <QueryClientProvider client={ready.client}>
        <Live>{children}</Live>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export { SOLANA_RPC_URL };
