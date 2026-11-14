"use client";

/**
 * The browser's own Solana wallet (Phantom, Jupiter, Solflare, Backpack): no WalletConnect, nothing loaded until the person
 * connects. The transfer is built with @solana/web3.js, imported only when a payment is sent.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { readStored, removeStored, writeStored } from "@/lib/storage";

interface InjectedSolana {
  isConnected?: boolean;
  publicKey?: { toString(): string } | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect?(): Promise<void>;
  signAndSendTransaction(transaction: unknown): Promise<{ signature: string } | string>;
}

/** One Solana wallet installed in this browser. */
export interface SolanaWallet {
  id: string;
  name: string;
  wallet: InjectedSolana;
}

/** Every Solana wallet the browser has, in the order people most often use them (one entry per wallet object). */
export function injectedSolanaWallets(): SolanaWallet[] {
  if (typeof window === "undefined") return [];
  const w = window as unknown as {
    phantom?: { solana?: InjectedSolana };
    jupiter?: InjectedSolana & { solana?: InjectedSolana };
    solflare?: InjectedSolana;
    backpack?: InjectedSolana;
    solana?: InjectedSolana;
  };
  const all: [string, string, InjectedSolana | undefined][] = [
    ["phantom", "Phantom", w.phantom?.solana],
    ["jupiter", "Jupiter", w.jupiter?.solana ?? w.jupiter],
    ["solflare", "Solflare", w.solflare],
    ["backpack", "Backpack", w.backpack],
    ["solana", "Solana wallet", w.solana],
  ];
  const seen = new Set<InjectedSolana>();
  const out: SolanaWallet[] = [];
  for (const [id, name, wallet] of all)
    if (wallet && typeof wallet.connect === "function" && !seen.has(wallet)) {
      seen.add(wallet);
      out.push({ id, name, wallet });
    }
  return out;
}

const CHOSEN = "openrail.solana-wallet";

interface SolanaState {
  address: string | null;
  available: boolean;
  error: boolean;
  /** Every Solana wallet in this browser, so the payer picks one. */
  wallets: { id: string; name: string }[];
  connectedName: string | null;
  /** Connects the wallet with this id (the only one when there is just one). */
  connect: (id?: string) => Promise<void>;
  disconnect: () => void;
  /** A token transfer to `to`, signed and sent by the wallet; returns the signature. */
  pay: (request: { to: string; mint: string; amount: bigint; decimals: number }) => Promise<string>;
}

const Ctx = createContext<SolanaState | null>(null);

export function useSolana(): SolanaState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSolana must be used inside <SolanaProvider>");
  return ctx;
}

/**
 * The chosen wallet is remembered and reconnected silently on reload; disconnecting forgets it. It used to take the
 * first wallet found (Phantom before the others) and reconnect to it on every load, so a payer could not switch (14 Nov).
 */
export function SolanaProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [wallets, setWallets] = useState<SolanaWallet[]>([]);
  const [chosen, setChosen] = useState<SolanaWallet | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    // Extensions inject a moment after the page; look again shortly.
    const found = injectedSolanaWallets();
    setWallets(found);
    const later = window.setTimeout(() => setWallets(injectedSolanaWallets()), 500);
    const id = readStored(CHOSEN);
    const w = found.find((x) => x.id === id);
    w?.wallet
      .connect({ onlyIfTrusted: true })
      .then((r) => {
        setChosen(w);
        setAddress(r.publicKey.toString());
      })
      .catch(() => undefined);
    return () => window.clearTimeout(later);
  }, []);

  const connect = useCallback(
    async (id?: string) => {
      const w = wallets.find((x) => x.id === id) ?? (wallets.length === 1 ? wallets[0] : undefined);
      if (w === undefined) return;
      setError(false);
      try {
        const r = await w.wallet.connect();
        setChosen(w);
        setAddress(r.publicKey.toString());
        writeStored(CHOSEN, w.id);
      } catch {
        setError(true);
      }
    },
    [wallets],
  );

  const disconnect = useCallback(() => {
    void chosen?.wallet.disconnect?.().catch(() => undefined);
    removeStored(CHOSEN);
    setChosen(null);
    setAddress(null);
  }, [chosen]);

  const pay = useCallback<SolanaState["pay"]>(
    async ({ to, mint, amount, decimals }) => {
      const wallet = chosen?.wallet ?? null;
      if (wallet === null || address === null) throw new Error("wallet_not_connected");
      const { buildSolanaUsdcTransfer } = await import("./solana-pay");
      const { transaction } = await buildSolanaUsdcTransfer({
        from: address,
        to,
        mint,
        amount,
        decimals,
      });
      const sent = await wallet.signAndSendTransaction(transaction);
      return typeof sent === "string" ? sent : sent.signature;
    },
    [address, chosen],
  );

  const value = useMemo(
    () => ({
      address,
      available: wallets.length > 0,
      error,
      wallets: wallets.map(({ id, name }) => ({ id, name })),
      connectedName: chosen?.name ?? null,
      connect,
      disconnect,
      pay,
    }),
    [address, wallets, error, chosen, connect, disconnect, pay],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
