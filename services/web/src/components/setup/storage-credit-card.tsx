"use client";

import { useState } from "react";
import { copy } from "@/copy";
import { formatNear, storageCreditLow } from "@/lib/near-amount";
import type { Async } from "@/lib/use-async";
import { Card } from "../ui/card";
import { Skeleton } from "../ui/state";
import { DepositControl } from "./deposit-control";

type Credit = { balance: string; amount: string; contract_id: string };

/** The prepaid storage credit and the one-signature deposit. The parent owns the data so other cards can react. */
export function StorageCreditCard({
  credit,
  reload,
}: {
  credit: Async<Credit>;
  /** Called when a deposit was sent: the parent watches the balance until it changes. */
  reload: () => void;
}) {
  const t = copy.setup;
  const [sent, setSent] = useState(false);
  const balance = credit.state === "ready" ? BigInt(credit.data.balance) : null;
  const low = balance !== null && storageCreditLow(balance);

  return (
    <Card title={t.creditTitle} className="space-y-3">
      {credit.state === "loading" ? (
        <Skeleton className="h-6 w-32" />
      ) : credit.state === "error" ? (
        <p className="caption">{t.creditUnknown}</p>
      ) : (
        <>
          <p className="tabular text-[20px] leading-7 font-bold">{formatNear(balance!)} NEAR</p>
          <p className="caption">{t.creditHelp}</p>
          {low ? (
            <p role="status" className="text-warning text-[14px]">
              {t.creditLow}
            </p>
          ) : null}
          {low || sent ? (
            <DepositControl
              contractId={credit.data.contract_id}
              suggestedYocto={credit.data.amount}
              onSent={() => {
                setSent(true);
                reload();
              }}
            />
          ) : null}
        </>
      )}
    </Card>
  );
}
