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
  const { state, retry, signIn } = useAuth();
  const demo = state.status === "signedIn" && state.demo === true;
  const router = useRouter();

  // Before the page renders (its effects run before this component's), so its first reads are already the guest ones.
  setGuestMode(state.status === "signedOut");

  // Right after signing in (not on a reload of a signed-in page): a new business starts at onboarding, an existing
  // one at the dashboard, whatever page the sign-in started from.
  // "demo" counts as signed out here: leaving the demo by signing in is a sign-in like any other.
  const phase = demo ? "demo" : state.status;
  const before = useRef(phase);
  useEffect(() => {
    const was = before.current;
    before.current = phase;
    if (phase === "demo" && was === "signedOut") {
      router.replace("/app");
      return;
    }
    if (phase !== "signedIn" || (was !== "signedOut" && was !== "demo")) return;
    void dashClient.business
      .get()
      .then((b) => {
        // The API creates a new business with its account id as the name, so that means "not set up yet" too: a fresh
        // OKX account skipped onboarding (14 Nov).
        const isNew =
          b.legal_name.trim() === "" ||
          b.payout_account.trim() === "" ||
          b.legal_name === b.account_id;
        router.replace(isNew ? "/app/onboarding" : "/app");
      })
      .catch(() => router.replace("/app/onboarding"));
  }, [phase, router]);

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
  if (demo)
    return (
      <div key="demo">
        <DemoBanner onSignIn={() => void signIn()} />
        {children}
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
  const { signIn, startDemo } = useAuth();
  const [at, setAt] = useState<{ x: number; y: number; n: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!at) return;
    const t = setTimeout(() => setAt(null), 4000);
    return () => clearTimeout(t);
  }, [at]);

  const W = 272;
  const left = at ? Math.max(12, Math.min(at.x - W / 2, window.innerWidth - W - 12)) : 0;
  const top = at ? (at.y + 190 > window.innerHeight ? at.y - 182 : at.y + 14) : 0;

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
              <Button
                size="sm"
                variant="secondary"
                className="mt-2 w-full"
                onClick={() => {
                  setAt(null);
                  void startDemo().catch(() => undefined);
                }}
              >
                {copy.demo.cta}
              </Button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** Top of every page in the demo: whose pages these are, that they are live and that nothing can be changed. */
function DemoBanner({ onSignIn }: { onSignIn: () => void }) {
  const t = copy.demo;
  return (
    <div
      role="note"
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/40 bg-accent-soft px-4 py-3"
    >
      <p className="text-[14px] leading-6">
        <strong className="font-semibold text-accent-text">{t.label}</strong> {t.body}
      </p>
      <Button size="sm" variant="secondary" className="shrink-0" onClick={onSignIn}>
        {t.signIn}
      </Button>
    </div>
  );
}
