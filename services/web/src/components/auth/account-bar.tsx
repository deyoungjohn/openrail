"use client";

import { copy } from "@/copy";
import { AccountId } from "../ui/account-id";
import { Button } from "../ui/button";
import { useAuth } from "./auth-provider";

/** Who is signed in and how to sign out. Renders nothing while signed out. */
export function AccountBar() {
  const { state, signOut } = useAuth();
  if (state.status !== "signedIn") return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="caption">{copy.auth.signedInAs}</span>
      <AccountId value={state.accountId} />
      <Button variant="secondary" size="sm" onClick={() => void signOut()}>
        {copy.wallet.signOut}
      </Button>
    </div>
  );
}
