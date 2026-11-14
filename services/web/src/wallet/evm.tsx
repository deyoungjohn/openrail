"use client";

import {
  createWalletClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  numberToHex,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { readStored, removeStored, writeStored } from "@/lib/storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** One EVM wallet installed in this browser, as it announced itself (EIP-6963). */
export interface EvmWallet {
  id: string;
  name: string;
  icon: string;
  provider: EIP1193Provider;
}

interface EvmState {
  address: Address | null;
  /** False when no injected provider exists in this browser. */
  available: boolean;
  error: boolean;
  /** Every EVM wallet in this browser, so the payer picks one instead of whichever took `window.ethereum`. */
  wallets: EvmWallet[];
  /** The name of the connected wallet. */
  connectedName: string | null;
  /** Connects the wallet with this id (the only one when there is just one), asking it which account to use. */
  connect: (id?: string) => Promise<void>;
  /** Forgets the wallet: its permission is revoked where the wallet allows it, and it is not reconnected on reload. */
  disconnect: () => void;
  /**
   * Send the payment from the connected wallet: switch to the route's chain, then a plain transfer
   * (native coin when `token` is null, an ERC-20 transfer otherwise). The wallet asks the person to approve.
   */
  pay: (request: {
    chainId: number;
    to: Address;
    amount: bigint;
    token: Address | null;
  }) => Promise<Hex>;
}

declare global {
  interface Window {
    /** The browser's injected EVM wallet (EIP-1193), when there is one. */
    ethereum?: EIP1193Provider;
  }
}

const Ctx = createContext<EvmState | null>(null);

export function useEvm() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useEvm must be used inside <EvmProvider>");
  return ctx;
}

/** Switch the wallet to the route's chain, then a plain transfer (the native coin, or an ERC-20 transfer). */
export async function sendEvmPayment(
  provider: EIP1193Provider,
  from: Address,
  {
    chainId,
    to,
    amount,
    token,
  }: { chainId: number; to: Address; amount: bigint; token: Address | null },
): Promise<Hex> {
  const current = await provider.request({ method: "eth_chainId" });
  if (typeof current !== "string" || parseInt(current, 16) !== chainId) {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: numberToHex(chainId) }],
    });
  }
  const tx =
    token === null
      ? { from, to, value: numberToHex(amount) }
      : {
          from,
          to: token,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
        };
  const hash = await provider.request({ method: "eth_sendTransaction", params: [tx] });
  return hash as Hex;
}

const CHOSEN = "openrail.evm-wallet";

interface Announced {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}

/**
 * The browser's own EVM wallets, found with EIP-6963 (each extension announces itself); `window.ethereum` only when
 * none announces. The chosen one is remembered by its id and reconnected silently on reload; disconnecting forgets it.
 * It used to take `window.ethereum` and reconnect to it on every load, so a payer could never switch wallets (14 Nov).
 */
export function EvmProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address | null>(null);
  const [wallets, setWallets] = useState<EvmWallet[]>([]);
  const [chosen, setChosen] = useState<EvmWallet | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const found = new Map<string, EvmWallet>();
    const publish = () => setWallets([...found.values()]);
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<Announced>).detail;
      if (!d?.info?.rdns || !d.provider) return;
      found.set(d.info.rdns, {
        id: d.info.rdns,
        name: d.info.name,
        icon: d.info.icon,
        provider: d.provider,
      });
      publish();
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // A wallet too old for EIP-6963 is still offered, as the browser wallet.
    const fallback = window.setTimeout(() => {
      if (found.size === 0 && window.ethereum)
        found.set("injected", {
          id: "injected",
          name: "Browser wallet",
          icon: "",
          provider: window.ethereum,
        });
      publish();
    }, 400);
    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      window.clearTimeout(fallback);
    };
  }, []);

  // Reconnect silently only to the wallet chosen before, and only if it still lets this site see an account.
  useEffect(() => {
    if (chosen !== null) return;
    const id = readStored(CHOSEN);
    const w = id === null ? undefined : wallets.find((x) => x.id === id);
    if (w === undefined) return;
    void (w.provider.request({ method: "eth_accounts" }) as Promise<Address[]>)
      .then((a) => {
        if (a[0]) {
          setChosen(w);
          setAddress(a[0]);
        }
      })
      .catch(() => undefined);
  }, [wallets, chosen]);

  useEffect(() => {
    if (chosen === null) return;
    const onAccounts = (accounts: unknown) => {
      const first = Array.isArray(accounts) ? (accounts[0] as Address | undefined) : undefined;
      setAddress(first ?? null);
    };
    chosen.provider.on("accountsChanged", onAccounts);
    return () => chosen.provider.removeListener("accountsChanged", onAccounts);
  }, [chosen]);

  const connect = useCallback(
    async (id?: string) => {
      const w = wallets.find((x) => x.id === id) ?? (wallets.length === 1 ? wallets[0] : undefined);
      if (w === undefined) return;
      setError(false);
      try {
        // Ask the wallet for permission again, so it shows its account picker instead of reusing the last account.
        await w.provider
          .request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] } as never)
          .catch(() => undefined);
        const [first] = await createWalletClient({
          transport: custom(w.provider),
        }).requestAddresses();
        setChosen(w);
        setAddress(first ?? null);
        writeStored(CHOSEN, w.id);
      } catch {
        setError(true);
      }
    },
    [wallets],
  );

  const disconnect = useCallback(() => {
    void chosen?.provider
      .request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] } as never)
      .catch(() => undefined);
    removeStored(CHOSEN);
    setChosen(null);
    setAddress(null);
  }, [chosen]);

  const pay = useCallback<EvmState["pay"]>(
    async (request) => {
      if (!chosen || !address) throw new Error("wallet_not_connected");
      return sendEvmPayment(chosen.provider, address, request);
    },
    [chosen, address],
  );

  const value = useMemo(
    () => ({
      address,
      available: wallets.length > 0,
      error,
      wallets,
      connectedName: chosen?.name ?? null,
      connect,
      disconnect,
      pay,
    }),
    [address, wallets, error, chosen, connect, disconnect, pay],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
