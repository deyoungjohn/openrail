"use client";

import { useState, type ReactNode } from "react";
import { copy } from "@/copy";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ErrorState } from "../ui/state";
import { useAuth } from "./auth-provider";
import { ErrorNote } from "@/components/ui/error-note";

/** Dashboard content only renders for a signed-in business. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { state, signIn, hint, cancelSignIn, retry } = useAuth();
  const [busy, setBusy] = useState(false);

  if (state.status === "loading") return <Card state="loading" />;
  if (state.status === "error")
    return (
      <div className="surface-card">
        <ErrorState title={copy.auth.errorTitle} body={copy.auth.errorBody} onRetry={retry} />
      </div>
    );
  if (state.status === "signedOut")
    return (
      <div className="surface-card mx-auto max-w-md space-y-4 p-8">
        <h1 className="text-[24px] leading-8 font-bold">{copy.auth.title}</h1>
        <p className="text-[15px]">{copy.auth.body}</p>
        {state.failed ? (
          <ErrorNote>
            {state.detail ? `${copy.auth.walletSaid}: ${state.detail}. ` : ""}
            {state.failed === "unsupported"
              ? copy.auth.unsupported
              : state.failed === "timeout"
                ? copy.auth.timeout
                : copy.auth.failed}
          </ErrorNote>
        ) : null}
        {busy && hint ? <p className="caption">{hint}</p> : null}
        <div className="flex items-center gap-3">
          <Button
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
          {busy ? (
            <Button variant="secondary" onClick={cancelSignIn}>
              {copy.auth.cancel}
            </Button>
          ) : null}
        </div>
      </div>
    );
  return <>{children}</>;
}
