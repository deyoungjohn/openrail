"use client";

import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { AccountId } from "../ui/account-id";
import { Button } from "../ui/button";
import { useToast } from "../ui/toast";
import { useAuth } from "./auth-provider";

/**
 * Top right of the app. Signed in: who, and sign out. Signed out: the Sign in button that opens the wallet picker
 * (the pages behind it are a preview until then), with Cancel while the wallet is open and what went wrong if it did.
 */
export function AccountBar({ place = "page" }: { place?: "header" | "menu" | "page" } = {}) {
  const { state, signIn, signOut, cancelSignIn, hint, startDemo } = useAuth();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const failed = state.status === "signedOut" ? state.failed : undefined;
  const detail = state.status === "signedOut" ? state.detail : undefined;
  // A failed sign-in is told in a toast: the header has no room for a sentence (it wrapped one letter per line, 14 Nov),
  // and a toast never moves the page or covers a control. Only the header bar reports it, so it is told once.
  useEffect(() => {
    if (place !== "header" || !failed) return;
    toast({
      tone: "error",
      title:
        failed === "unsupported"
          ? copy.auth.unsupported
          : failed === "timeout"
            ? copy.auth.timeout
            : copy.auth.failed,
      ...(detail ? { body: `${copy.auth.walletSaid}: ${detail}` } : {}),
    });
  }, [failed, detail, place, toast]);
  // Only the header offers Sign in (one button on the page); elsewhere a signed-out bar is empty.
  if (state.status === "signedOut" && place === "header")
    return (
      <div className="flex min-w-0 items-center gap-2">
        {busy && hint ? <span className="caption hidden truncate lg:inline">{hint}</span> : null}
        {!busy ? (
          <Button
            variant="secondary"
            size="sm"
            className="hidden shrink-0 whitespace-nowrap sm:inline-flex"
            onClick={() => void startDemo().catch(() => undefined)}
          >
            {copy.demo.cta}
          </Button>
        ) : null}
        {busy ? (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            onClick={cancelSignIn}
          >
            {copy.auth.cancel}
          </Button>
        ) : null}
        <Button
          size="sm"
          className="shrink-0 whitespace-nowrap"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await signIn();
            } finally {
              setBusy(false);
            }
          }}
        >
          {copy.wallet.signIn}
        </Button>
      </div>
    );
  if (state.status !== "signedIn") return null;
  if (state.demo)
    return (
      <div
        className={
          place === "header"
            ? "hidden flex-wrap items-center gap-2 sm:flex"
            : "flex flex-wrap items-center gap-2"
        }
      >
        <span className="caption">{copy.demo.label}</span>
        <Button variant="secondary" size="sm" onClick={() => void signOut()}>
          {copy.demo.exit}
        </Button>
      </div>
    );
  return (
    // In the header, phones show the account in the menu instead (the bar is narrow there).
    <div
      className={
        place === "header"
          ? "hidden flex-wrap items-center gap-2 sm:flex"
          : "flex flex-wrap items-center gap-2"
      }
    >
      <span className="caption">{copy.auth.signedInAs}</span>
      <AccountId value={state.accountId} />
      <Button variant="secondary" size="sm" onClick={() => void signOut()}>
        {copy.wallet.signOut}
      </Button>
    </div>
  );
}
