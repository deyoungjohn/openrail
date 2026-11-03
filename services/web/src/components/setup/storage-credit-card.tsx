"use client";

import { useState } from "react";
import { copy } from "@/copy";
import { formatNear, storageCreditLow } from "@/lib/near-amount";
import type { Async } from "@/lib/use-async";
import { useActions } from "@/wallet/actions";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Skeleton } from "../ui/state";

type Credit = { balance: string; amount: string; contract_id: string };

/** The prepaid storage credit and the one-signature deposit. The parent owns the data so other cards can react. */
export function StorageCreditCard({
  credit,
  reload,
}: {
  credit: Async<Credit>;
  reload: () => void;
}) {
  const t = copy.setup;
  const actions = useActions();
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
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
          {low || state === "sent" ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                loading={state === "sending"}
                onClick={async () => {
                  setState("sending");
                  try {
                    await actions.depositStorageCredit(credit.data.contract_id, credit.data.amount);
                    setState("sent");
                    reload();
                  } catch {
                    setState("failed");
                  }
                }}
              >
                {t.creditDeposit}
              </Button>
              {state === "sent" ? (
                <span role="status" className="text-[14px]">
                  {t.creditSent}
                </span>
              ) : null}
              {state === "failed" ? (
                <span role="alert" className="text-danger-text text-[14px]">
                  {t.creditFailed}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
