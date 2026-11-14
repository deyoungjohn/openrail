"use client";

import { useRouter } from "next/navigation";
import { LogIn } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { dashClient, setGuestMode } from "@/lib/client";
import { copy } from "@/copy";
import { Button } from "../ui/button";
import { PageSkeleton } from "../ui/page-skeleton";
import { ErrorState } from "../ui/state";
import { useAuth } from "./auth-provider";

/**
 * Signed in: the page. Signed out: the same page as a preview, with its layout and nothing in it ($0.00, empty tables),
 * and nothing on it can be used until the visitor signs in with the button top right (14 Nov, human: people want to see
 * before they sign in). The preview reads come from the client's guest mode, so no request leaves the browser.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { state, retry } = useAuth();
  const router = useRouter();

  // Before the page renders (its effects run before this component's), so its first reads are already the guest ones.
  setGuestMode(state.status === "signedOut");

  // Right after signing in (not on a reload of a signed-in page): a new business starts at onboarding, an existing
  // one at the dashboard, whatever page the sign-in started from.
  const before = useRef(state.status);
  useEffect(() => {
    const was = before.current;
    before.current = state.status;
    if (state.status !== "signedIn" || was !== "signedOut") return;
    void dashClient.business
      .get()
      .then((b) => {
        const isNew = b.legal_name.trim() === "" || b.payout_account.trim() === "";
        router.replace(isNew ? "/app/onboarding" : "/app");
      })
      .catch(() => router.replace("/app/onboarding"));
  }, [state.status, router]);

  if (state.status === "loading") return <PageSkeleton />;
  if (state.status === "error")
    return (
      <div className="surface-card">
        <ErrorState title={copy.auth.errorTitle} body={copy.auth.errorBody} onRetry={retry} />
      </div>
    );
  if (state.status === "signedOut")
    return (
      // A preview: shown, readable, but nothing can be clicked, typed or focused (`inert`). Keyed so the page mounts
      // again with real data after sign-in.
      <div key="preview" className="relative">
        <div inert className="select-none" aria-label={copy.auth.previewLabel}>
          {children}
        </div>
        <SignInNudge />
      </div>
    );
  return <div key="app">{children}</div>;
}

/**
 * A click anywhere on the preview says why nothing happens: a small card at the pointer with a Sign in button, so a
 * signed-out visitor never thinks the page is broken (14 Nov). Keyboard users have the Sign in button in the header;
 * this layer is for the pointer only.
 */
function SignInNudge() {
  const { signIn } = useAuth();
  const [at, setAt] = useState<{ x: number; y: number; n: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!at) return;
    const t = setTimeout(() => setAt(null), 4000);
    return () => clearTimeout(t);
  }, [at]);

  const W = 272;
  const left = at ? Math.max(12, Math.min(at.x - W / 2, window.innerWidth - W - 12)) : 0;
  const top = at ? (at.y + 140 > window.innerHeight ? at.y - 132 : at.y + 14) : 0;

  return (
    <>
      <div
        aria-hidden
        data-testid="preview-click-layer"
        className="absolute inset-0 z-10 cursor-not-allowed"
        onClick={(e) => setAt((p) => ({ x: e.clientX, y: e.clientY, n: (p?.n ?? 0) + 1 }))}
      />
      {at
        ? createPortal(
            <div
              key={at.n}
              role="status"
              style={{ left, top, width: W }}
              className="fixed z-[90] rounded-2xl border border-border bg-surface p-4 shadow-xl"
            >
              <p className="text-[14px] leading-5 font-semibold">{copy.auth.nudgeTitle}</p>
              <p className="caption mt-1">{copy.auth.nudgeBody}</p>
              <Button
                size="sm"
                className="mt-3 w-full"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  setAt(null);
                  try {
                    await signIn();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <LogIn aria-hidden size={15} /> {copy.wallet.signIn}
              </Button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
