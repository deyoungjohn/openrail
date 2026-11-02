"use client";

import { createWalletClient, custom, type Address, type EIP1193Provider } from "viem";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface EvmState {
  address: Address | null;
  /** False when no injected provider exists in this browser. */
  available: boolean;
  error: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const Ctx = createContext<EvmState | null>(null);

export function useEvm() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useEvm must be used inside <EvmProvider>");
  return ctx;
}

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

// Injected provider only (window.ethereum). We hold no key and sign nothing here.
export function EvmProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address | null>(null);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const provider = window.ethereum;
    setAvailable(Boolean(provider));
    if (!provider) return;
    // Reconnect silently if the site is already permitted.
    createWalletClient({ transport: custom(provider) })
      .getAddresses()
      .then((a) => setAddress(a[0] ?? null))
      .catch(() => {});
    const onAccounts = (accounts: unknown) => {
      const first = Array.isArray(accounts) ? (accounts[0] as Address | undefined) : undefined;
      setAddress(first ?? null);
    };
    provider.on("accountsChanged", onAccounts);
    return () => provider.removeListener("accountsChanged", onAccounts);
  }, []);

  const connect = useCallback(async () => {
    const provider = window.ethereum;
    if (!provider) return;
    setError(false);
    try {
      const [first] = await createWalletClient({ transport: custom(provider) }).requestAddresses();
      setAddress(first ?? null);
    } catch {
      setError(true);
    }
  }, []);

  const disconnect = useCallback(() => setAddress(null), []);
  const value = useMemo(
    () => ({ address, available, error, connect, disconnect }),
    [address, available, error, connect, disconnect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
