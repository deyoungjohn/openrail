"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { dashClient, setGuestMode } from "@/lib/client";
import { copy } from "@/copy";
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
      <div key="preview" inert className="select-none" aria-label={copy.auth.previewLabel}>
        {children}
      </div>
    );
  return <div key="app">{children}</div>;
}
