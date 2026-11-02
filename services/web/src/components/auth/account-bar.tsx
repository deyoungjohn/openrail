"use client";

import { copy } from "@/copy";
import { Button } from "../ui/button";
import { useAuth } from "./auth-provider";

/** Who is signed in and how to sign out. Renders nothing while signed out. */
export function AccountBar() {
  const { state, signOut } = useAuth();
  if (state.status !== "signedIn") return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="caption">{copy.auth.signedInAs}</span>
      <code className="font-mono text-[13px]">{state.accountId}</code>
      <Button variant="secondary" size="sm" onClick={() => void signOut()}>
        {copy.wallet.signOut}
      </Button>
    </div>
  );
}
