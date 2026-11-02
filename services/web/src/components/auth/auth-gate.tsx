"use client";

import { useState, type ReactNode } from "react";
import { copy } from "@/copy";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ErrorState } from "../ui/state";
import { useAuth } from "./auth-provider";

/** Dashboard content only renders for a signed-in business. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { state, signIn, retry } = useAuth();
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
          <p role="alert" className="text-danger-text text-[14px]">
            {copy.auth.failed}
          </p>
        ) : null}
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await signIn();
            setBusy(false);
          }}
        >
          {copy.wallet.signIn}
        </Button>
      </div>
    );
  return <>{children}</>;
}
