"use client";

import {
  actionCreators,
  setupWalletSelector,
  type WalletSelector,
} from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import "@near-wallet-selector/modal-ui/styles.css";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface NearState {
  accountId: string | null;
  ready: boolean;
  error: boolean;
  signIn: () => void;
  signOut: () => Promise<void>;
  /** One FunctionCall transaction, signed by the connected NEAR wallet. */
  call: (c: NearCall) => Promise<void>;
}

export interface NearCall {
  receiverId: string;
  methodName: string;
  args: object;
  /** Gas as a decimal string of gas units. */
  gas: string;
  /** Deposit in yoctoNEAR as a decimal string. */
  deposit: string;
}

const Ctx = createContext<NearState | null>(null);

export function useNear() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNear must be used inside <NearProvider>");
  return ctx;
}

const network = process.env.NEXT_PUBLIC_NEAR_NETWORK === "testnet" ? "testnet" : "mainnet";

// No contract is passed to the modal: the shell only identifies the account. Function-call
// access keys are requested by the screens that need them.
export function NearProvider({ children }: { children: ReactNode }) {
  const selector = useRef<WalletSelector | null>(null);
  const modal = useRef<WalletSelectorModal | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setupWalletSelector({ network, modules: [setupMyNearWallet()] })
      .then((s) => {
        if (cancelled) return;
        selector.current = s;
        modal.current = setupModal(s, { theme: "auto" });
        const sub = s.store.observable.subscribe((state) => {
          const active = state.accounts.find((a) => a.active) ?? state.accounts[0];
          setAccountId(active?.accountId ?? null);
        });
        unsubscribe = () => sub.unsubscribe();
        setReady(true);
      })
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const signIn = useCallback(() => modal.current?.show(), []);
  const signOut = useCallback(async () => {
    const s = selector.current;
    if (!s?.isSignedIn()) return;
    const wallet = await s.wallet();
    await wallet.signOut();
  }, []);

  const call = useCallback(async (c: NearCall) => {
    const s = selector.current;
    if (!s?.isSignedIn()) throw new Error("NOT_SIGNED_IN");
    const wallet = await s.wallet();
    await wallet.signAndSendTransaction({
      receiverId: c.receiverId,
      actions: [
        actionCreators.functionCall(c.methodName, c.args, BigInt(c.gas), BigInt(c.deposit)),
      ],
    });
  }, []);

  const value = useMemo(
    () => ({ accountId, ready, error, signIn, signOut, call }),
    [accountId, ready, error, signIn, signOut, call],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
