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
import { abortable } from "./abortable";
import { signInParams } from "./sign-in-params";
import { classifyProbe, staticSignsMessage } from "./probe";

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
  /** Connects one wallet (its own pop-up or app). Rejects with `WALLET_CANCELLED` when `signal` aborts. */
  connect: (walletId: string, signal?: AbortSignal) => Promise<string | undefined>;
  signOut: () => Promise<void>;
  /** One FunctionCall transaction, signed by the connected NEAR wallet. */
  call: (c: NearCall) => Promise<string | undefined>;
  /** Several function calls to one contract in one transaction (one approval in the wallet). */
  callBatch: (
    receiverId: string,
    calls: Omit<NearCall, "receiverId">[],
  ) => Promise<string | undefined>;
  /** NEP-413 signature of the sign-in challenge. Throws `SIGNMESSAGE_UNSUPPORTED` for wallets without it. */
  signMessage: (c: ChallengeToSign, signal?: AbortSignal) => Promise<SignedChallenge>;
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

/** How long the live capability check may take for one wallet before its source decides. */

export function NearProvider({ children }: { children: ReactNode }) {
  const selector = useRef<WalletSelector | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [wallets, setWallets] = useState<NearWalletInfo[]>([]);
  const probed = useRef(false);
  /** True after a sign-out, until the next sign-in: the selector's store still lists the old account. */
  const signedOut = useRef(false);
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
          if (!signedOut.current) {
            setAccountId(active?.accountId ?? null);
            setWalletId(state.selectedWalletId);
          }
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
    // What each module can do is read from a table pinned to the installed versions (capabilities.test.ts), never by
    // calling the wallet: asking a wallet to sign an empty message opened Meteor's pop-up over the HOT wallet
    // while the person was signing in with HOT (10 Nov).
    setWallets((prev) => prev.map((p) => ({ ...p, signsMessage: staticSignsMessage(p.id) })));
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

  const connect = useCallback(async (id: string, signal?: AbortSignal) => {
    const s = selector.current;
    if (!s) throw new Error("WALLET_NOT_READY");
    const w = await abortable(s.wallet(id), signal);
    // Connect without a contract: sign-in is a signed message, so the wallet must not add an access
    // key. Adding one is a transaction, and some wallets refuse it below 0.1 NEAR. Every
    // transaction we ask for later (sell, acknowledge, deposit) is approved in the wallet itself.
    const accounts = await abortable(w.signIn(signInParams(id, ROOT_CONTRACT) as never), signal);
    signedOut.current = false;
    const state = s.store.getState();
    const account = accounts[0]?.accountId ?? state.accounts[0]?.accountId;
    // The store may not change when the same wallet signs in again after a local sign-out, so set it here.
    setAccountId(account ?? null);
    setWalletId(state.selectedWalletId ?? id);
    return account;
  }, []);

  const signIn = useCallback(() => {
    void pickWallet("connect").then((id) => (id ? connect(id) : undefined));
  }, [pickWallet, connect]);

  // Sign-out is local: the selector's saved session is dropped and no wallet is called. Sign-in never adds an access
  // key (see `connect`), so there is nothing in the wallet to revoke, and asking the wallet module to sign out opened
  // Meteor's pop-up on the pay page (14 Nov). Until the next sign-in the store's old account is ignored.
  const signOut = useCallback(async () => {
    signedOut.current = true;
    try {
      for (const k of Object.keys(window.localStorage))
        if (k.startsWith("near-wallet-selector") || k.startsWith("near_app_wallet"))
          window.localStorage.removeItem(k);
    } catch {
      // Storage is blocked; the state below still shows the person as signed out.
    }
    setAccountId(null);
    setWalletId(null);
  }, []);

  const callBatch = useCallback(
    async (receiverId: string, calls: Omit<NearCall, "receiverId">[]) => {
      const s = selector.current;
      if (!s?.isSignedIn() || signedOut.current) throw new Error("NOT_SIGNED_IN");
      const wallet = await s.wallet();
      const outcome = (await wallet.signAndSendTransaction({
        receiverId,
        actions: calls.map((c) =>
          actionCreators.functionCall(c.methodName, c.args, BigInt(c.gas), BigInt(c.deposit)),
        ),
      })) as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | void;
      const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
      return typeof hash === "string" ? hash : undefined;
    },
    [],
  );

  const call = useCallback(async (c: NearCall) => {
    const s = selector.current;
    if (!s?.isSignedIn() || signedOut.current) throw new Error("NOT_SIGNED_IN");
    const wallet = await s.wallet();
    const outcome = (await wallet.signAndSendTransaction({
      receiverId: c.receiverId,
      actions: [
        actionCreators.functionCall(c.methodName, c.args, BigInt(c.gas), BigInt(c.deposit)),
      ],
    })) as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | void;
    // Wallets answer with the final outcome; the hash is on it (not every wallet returns one).
    const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
    return typeof hash === "string" ? hash : undefined;
  }, []);

  const signMessage = useCallback(
    async (c: ChallengeToSign, signal?: AbortSignal): Promise<SignedChallenge> => {
      const s = selector.current;
      if (!s) throw new Error("WALLET_NOT_READY");
      const wallet = await abortable(s.wallet(), signal);
      const nonce = Uint8Array.from(atob(c.nonce), (ch) => ch.charCodeAt(0));
      let signed;
      try {
        signed = await abortable(
          wallet.signMessage({
            message: c.message,
            recipient: c.recipient,
            nonce: Buffer.from(nonce),
          }),
          signal,
        );
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
    },
    [],
  );

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
      callBatch,
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
      callBatch,
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
