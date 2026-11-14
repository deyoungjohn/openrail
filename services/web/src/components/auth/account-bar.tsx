"use client";

import { useState } from "react";
import { copy } from "@/copy";
import { AccountId } from "../ui/account-id";
import { Button } from "../ui/button";
import { ErrorNote } from "../ui/error-note";
import { useAuth } from "./auth-provider";

/**
 * Top right of the app. Signed in: who, and sign out. Signed out: the Sign in button that opens the wallet picker
 * (the pages behind it are a preview until then), with Cancel while the wallet is open and what went wrong if it did.
 */
export function AccountBar({ place = "page" }: { place?: "header" | "menu" | "page" } = {}) {
  const { state, signIn, signOut, cancelSignIn, hint } = useAuth();
  const [busy, setBusy] = useState(false);
  // Only the header offers Sign in (one button on the page); elsewhere a signed-out bar is empty.
  if (state.status === "signedOut" && place === "header")
    return (
      <div className="flex min-w-0 items-center gap-2">
        {busy && hint ? <span className="caption hidden truncate lg:inline">{hint}</span> : null}
        <ErrorNote className="mt-0 hidden w-auto max-w-[36ch] text-right lg:block">
          {!busy && state.failed
            ? `${state.detail ? `${copy.auth.walletSaid}: ${state.detail}. ` : ""}${
                state.failed === "unsupported"
                  ? copy.auth.unsupported
                  : state.failed === "timeout"
                    ? copy.auth.timeout
                    : copy.auth.failed
              }`
            : null}
        </ErrorNote>
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
