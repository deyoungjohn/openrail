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

// Injected provider only (window.ethereum). We hold no key and sign nothing here.
export function EvmProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address | null>(null);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const provider = window.ethereum as EIP1193Provider | undefined;
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
    const provider = window.ethereum as EIP1193Provider | undefined;
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

  const pay = useCallback<EvmState["pay"]>(
    async (request) => {
      const provider = window.ethereum as EIP1193Provider | undefined;
      if (!provider || !address) throw new Error("wallet_not_connected");
      return sendEvmPayment(provider, address, request);
    },
    [address],
  );

  const value = useMemo(
    () => ({ address, available, error, connect, disconnect, pay }),
    [address, available, error, connect, disconnect, pay],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
