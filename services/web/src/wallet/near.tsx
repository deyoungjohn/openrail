"use client";

import {
  actionCreators,
  setupWalletSelector,
  type WalletSelector,
} from "@near-wallet-selector/core";
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
import type { ChallengeToSign, SignedChallenge } from "../lib/auth";
import { WalletPicker } from "../components/wallet-picker";
import type { PickerPurpose } from "./groups";
import { nearWalletModules } from "./near-wallets";
import { classifyProbe } from "./probe";

/** One wallet in the picker. `signsMessage`: true or false from the selector, null while unknown. */
export interface NearWalletInfo {
  id: string;
  name: string;
  iconUrl: string | null;
  type: string;
  /** False when the wallet cannot run here, for example an extension that is not installed. */
  available: boolean;
  signsMessage: boolean | null;
}

interface NearState {
  accountId: string | null;
  walletId: string | null;
  ready: boolean;
  error: boolean;
  wallets: NearWalletInfo[];
  /** Opens the wallet picker and then connects the wallet the person chose. */
  signIn: () => void;
  /** Opens the picker and returns the chosen wallet id, or null if it was closed. */
  pickWallet: (purpose: PickerPurpose) => Promise<string | null>;
  /** Connects one wallet (its own pop-up or app). */
  connect: (walletId: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** One FunctionCall transaction, signed by the connected NEAR wallet. */
  call: (c: NearCall) => Promise<void>;
  /** NEP-413 signature of the sign-in challenge. Throws `SIGNMESSAGE_UNSUPPORTED` for wallets without it. */
  signMessage: (c: ChallengeToSign) => Promise<SignedChallenge>;
  /** Asks the selector which wallets support signMessage. Safe to call again. */
  probeWallets: () => Promise<void>;
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
const ROOT_CONTRACT = process.env.NEXT_PUBLIC_ROOT_CONTRACT ?? "openrail.near";

export function NearProvider({ children }: { children: ReactNode }) {
  const selector = useRef<WalletSelector | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [wallets, setWallets] = useState<NearWalletInfo[]>([]);
  const probed = useRef(false);
  const [picker, setPicker] = useState<null | {
    purpose: PickerPurpose;
    done: (id: string | null) => void;
  }>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setupWalletSelector({ network, modules: nearWalletModules(window.location.origin) })
      .then((s) => {
        if (cancelled) return;
        selector.current = s;
        const sub = s.store.observable.subscribe((state) => {
          const active = state.accounts.find((a) => a.active) ?? state.accounts[0];
          setAccountId(active?.accountId ?? null);
          setWalletId(state.selectedWalletId);
          setWallets((prev) =>
            state.modules.map((m) => ({
              id: m.id,
              name: m.metadata.name,
              iconUrl: m.metadata.iconUrl || null,
              type: m.type,
              available: m.metadata.available,
              signsMessage: prev.find((p) => p.id === m.id)?.signsMessage ?? null,
            })),
          );
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

  const probeWallets = useCallback(async () => {
    const s = selector.current;
    if (!s || probed.current) return;
    probed.current = true;
    for (const m of s.store.getState().modules) {
      let verdict: boolean | null = null;
      try {
        const w = await s.wallet(m.id);
        // Empty parameters: an unsupported wallet is refused first, a supporting one fails validation.
        await w.signMessage({ message: "", recipient: "", nonce: Buffer.alloc(0) });
      } catch (e) {
        verdict = classifyProbe(e);
      }
      setWallets((prev) => prev.map((p) => (p.id === m.id ? { ...p, signsMessage: verdict } : p)));
    }
  }, []);

  const pickWallet = useCallback(
    (purpose: PickerPurpose) =>
      new Promise<string | null>((resolve) => {
        void probeWallets();
        setPicker({
          purpose,
          done: (id) => {
            setPicker(null);
            resolve(id);
          },
        });
      }),
    [probeWallets],
  );

  const connect = useCallback(async (id: string) => {
    const s = selector.current;
    if (!s) throw new Error("WALLET_NOT_READY");
    const w = await s.wallet(id);
    // The selector wants a contract for the access key a wallet adds; none of our calls need one
    // beyond the root contract, and sign-in itself is a signed message, not a transaction.
    await w.signIn({ contractId: ROOT_CONTRACT } as never);
  }, []);

  const signIn = useCallback(() => {
    void pickWallet("connect").then((id) => (id ? connect(id) : undefined));
  }, [pickWallet, connect]);

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

  const signMessage = useCallback(async (c: ChallengeToSign): Promise<SignedChallenge> => {
    const s = selector.current;
    if (!s) throw new Error("WALLET_NOT_READY");
    const wallet = await s.wallet();
    const nonce = Uint8Array.from(atob(c.nonce), (ch) => ch.charCodeAt(0));
    let signed;
    try {
      signed = await wallet.signMessage({
        message: c.message,
        recipient: c.recipient,
        nonce: Buffer.from(nonce),
      });
    } catch (e) {
      if (classifyProbe(e) === false) throw new Error("SIGNMESSAGE_UNSUPPORTED", { cause: e });
      throw e;
    }
    if (!signed) throw new Error("WALLET_NO_SIGNATURE");
    return {
      accountId: signed.accountId,
      publicKey: signed.publicKey,
      signature: signed.signature,
    };
  }, []);

  const value = useMemo(
    () => ({
      accountId,
      walletId,
      ready,
      error,
      wallets,
      signIn,
      pickWallet,
      connect,
      signOut,
      call,
      signMessage,
      probeWallets,
    }),
    [
      accountId,
      walletId,
      ready,
      error,
      wallets,
      signIn,
      pickWallet,
      connect,
      signOut,
      call,
      signMessage,
      probeWallets,
    ],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <WalletPicker
        wallets={wallets}
        open={picker !== null}
        purpose={picker?.purpose}
        onPick={(id) => picker?.done(id)}
        onClose={() => picker?.done(null)}
      />
    </Ctx.Provider>
  );
}
