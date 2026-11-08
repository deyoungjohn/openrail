"use client";

import { Landmark } from "lucide-react";
import Link from "next/link";
import { copy } from "@/copy";
import { MOCK_MODE } from "@/lib/auth";
import { formatUsdcExact } from "@/lib/format";
import { useBalance } from "@/lib/use-balance";
import { useAuth } from "../auth/auth-provider";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Skeleton } from "../ui/state";

/**
 * What the business has been paid and holds. A payment lands as a balance of `intents.near` under the business's
 * NEAR account, so a NEAR wallet does not list it: this card is where it is seen, and cashed out.
 */
export function BalanceCard() {
  const t = copy.balance;
  const { state } = useAuth();
  const account = state.status === "signedIn" ? state.accountId : null;
  const [balance] = useBalance(MOCK_MODE ? null : account);
  if (MOCK_MODE || account === null) return null;
  return (
    <Card title={t.title} info={t.info(account)}>
      {balance.state === "loading" ? (
        <Skeleton className="h-10 w-48" />
      ) : balance.state === "error" ? (
        <p className="caption">{t.unreadable}</p>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <p className="tabular text-[32px] leading-10 font-bold" data-testid="balance-total">
              ${formatUsdcExact(balance.data.total)}
            </p>
            <p className="caption">
              {balance.data.lines.length === 0
                ? t.none
                : balance.data.lines
                    .map((l) => `${t.on(l.network)} ${formatUsdcExact(l.units)}`)
                    .join(" · ")}
            </p>
            <p className="caption">{t.where(account)}</p>
          </div>
          <Link href="/app/cashout">
            <Button icon={<Landmark size={18} strokeWidth={1.5} aria-hidden />}>{t.cashOut}</Button>
          </Link>
        </div>
      )}
    </Card>
  );
}
