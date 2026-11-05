"use client";

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
import { copy } from "@/copy";
import { auth, MOCK_MODE, MOCK_ACCOUNT } from "@/lib/auth";
import { useNear } from "@/wallet/near";
import { walletHint } from "@/wallet/hints";
import { walletDetail } from "@/wallet/wallet-detail";

export type AuthState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "signedOut"; failed?: "unsupported" | "failed" | "timeout"; detail?: string }
  | { status: "signedIn"; accountId: string };

interface AuthCtx {
  state: AuthState;
  signIn: () => Promise<void>;
  /** A short hint about the wallet being used, shown while we wait for it. */
  hint: string | null;
  /** Stops waiting for the wallet (closed pop-up, app that never answers). */
  cancelSignIn: () => void;
  signOut: () => Promise<void>;
  retry: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

/** Wallets whose sign-out opens a pop-up: we skip it, the dashboard session is ours to end. */
const QUIET_SIGN_OUT: readonly string[] = ["meteor-wallet"];

/** A wallet that has not answered after this long is treated as closed. */
export const WALLET_TIMEOUT_MS = 120_000;
/** WalletConnect either shows its QR code at once or not at all, so it gets a shorter wait. */
const WALLET_TIMEOUT_BY_ID: Record<string, number> = { "wallet-connect": 30_000 };

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/**
 * Restores the dashboard session on load with one GET. A signed-in reload shows the dashboard at
 * once; only a 401 asks for a wallet signature. The token lives in an HttpOnly cookie, never here.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const near = useNear();
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let off = false;
    setState({ status: "loading" });
    auth
      .session()
      .then((s) => {
        if (off) return;
        setState(s ? { status: "signedIn", accountId: s.account_id } : { status: "signedOut" });
      })
      .catch(() => !off && setState({ status: "error" }));
    return () => {
      off = true;
    };
  }, [tick]);

  const pending = useRef<AbortController | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const cancelSignIn = useCallback(() => pending.current?.abort(), []);

  const signIn = useCallback(async () => {
    pending.current?.abort();
    const ctl = new AbortController();
    pending.current = ctl;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startTimer = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, ms);
    };
    try {
      let accountId: string | undefined;
      if (!MOCK_MODE) {
        const id = await near.pickWallet("signIn");
        if (!id) return;
        startTimer(WALLET_TIMEOUT_BY_ID[id] ?? WALLET_TIMEOUT_MS);
        setHint(
          walletHint(id, Boolean((window as { hotExtension?: unknown }).hotExtension), copy.auth),
        );
        accountId = await near.connect(id, ctl.signal);
        startTimer(WALLET_TIMEOUT_BY_ID[id] ?? WALLET_TIMEOUT_MS);
      }
      const s = await auth.signIn((c) => near.signMessage(c, ctl.signal), accountId);
      setState({ status: "signedIn", accountId: s.account_id });
    } catch (e) {
      const cancelled = e instanceof Error && e.message === "WALLET_CANCELLED";
      if (cancelled && !timedOut) {
        setState({ status: "signedOut" });
        return;
      }
      // The wallet's own words go to the console, so a failure can be traced, and a short line to the screen.
      console.error("sign-in failed", e);
      setState({
        status: "signedOut",
        failed: timedOut
          ? "timeout"
          : e instanceof Error && e.message === "SIGNMESSAGE_UNSUPPORTED"
            ? "unsupported"
            : "failed",
        ...(timedOut ? {} : { detail: walletDetail(e) }),
      });
    } finally {
      clearTimeout(timer);
      setHint(null);
      if (pending.current === ctl) pending.current = null;
    }
  }, [near]);

  const signOut = useCallback(async () => {
    try {
      await auth.signOut();
      setState({ status: "signedOut" });
    } finally {
      // Wallet sign-out is best effort: the API session is what guards the dashboard.
      // Signing out of the wallet is best effort, and some wallets (Meteor) open a window for it. The API
      // session is what guards the dashboard, so those wallets keep their own connection quietly.
      if (!MOCK_MODE && !(near.walletId && QUIET_SIGN_OUT.includes(near.walletId))) {
        await near.signOut().catch(() => {});
      }
    }
  }, [near]);

  const retry = useCallback(() => setTick((t) => t + 1), []);
  const value = useMemo(
    () => ({ state, signIn, hint, cancelSignIn, signOut, retry }),
    [state, signIn, hint, cancelSignIn, signOut, retry],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export { MOCK_ACCOUNT };
