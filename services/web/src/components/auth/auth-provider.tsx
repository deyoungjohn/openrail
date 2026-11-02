"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { auth, MOCK_MODE, MOCK_ACCOUNT } from "@/lib/auth";
import { useNear } from "@/wallet/near";

export type AuthState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "signedOut"; failed?: "unsupported" | "failed" }
  | { status: "signedIn"; accountId: string };

interface AuthCtx {
  state: AuthState;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  retry: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

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

  const signIn = useCallback(async () => {
    try {
      if (!MOCK_MODE) {
        const id = await near.pickWallet("signIn");
        if (!id) return;
        await near.connect(id);
      }
      const s = await auth.signIn(near.signMessage);
      setState({ status: "signedIn", accountId: s.account_id });
    } catch (e) {
      setState({
        status: "signedOut",
        failed:
          e instanceof Error && e.message === "SIGNMESSAGE_UNSUPPORTED" ? "unsupported" : "failed",
      });
    }
  }, [near]);

  const signOut = useCallback(async () => {
    try {
      await auth.signOut();
      setState({ status: "signedOut" });
    } finally {
      // Wallet sign-out is best effort: the API session is what guards the dashboard.
      if (!MOCK_MODE) await near.signOut().catch(() => {});
    }
  }, [near]);

  const retry = useCallback(() => setTick((t) => t + 1), []);
  const value = useMemo(() => ({ state, signIn, signOut, retry }), [state, signIn, signOut, retry]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export { MOCK_ACCOUNT };
