"use client";

import { Landmark } from "lucide-react";
import Link from "next/link";
import { copy } from "@/copy";
import { MOCK_MODE } from "@/lib/auth";
import { formatUsd } from "@/lib/format";
import { useBalance } from "@/lib/use-balance";
import { useAuth } from "../auth/auth-provider";
import { Button } from "../ui/button";

/**
 * A payment lands as a balance of `intents.near` under the business's NEAR account, so a NEAR wallet does not list
 * it. This button shows that balance and opens the cash-out page.
 */
export function BalanceButton() {
  const t = copy.balance;
  const { state } = useAuth();
  const account = state.status === "signedIn" ? state.accountId : null;
  const [balance] = useBalance(MOCK_MODE ? null : account);
  const shown =
    MOCK_MODE || account === null
      ? t.cashOut
      : balance.state === "loading"
        ? t.loading
        : balance.state === "error"
          ? t.unreadableShort
          : `${t.label} ${formatUsd(balance.data.total / 10_000n)}`;
  return (
    <Link href="/app/cashout" aria-label={t.openCashOut}>
      <Button icon={<Landmark size={18} strokeWidth={1.5} aria-hidden />}>
        <span className="tabular" data-testid="balance-total">
          {shown}
        </span>
      </Button>
    </Link>
  );
}
