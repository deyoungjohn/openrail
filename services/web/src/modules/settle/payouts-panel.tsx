"use client";

import { useCallback, useEffect, useState } from "react";
import { dashClient } from "@/lib/client";
import { useAsync } from "@/lib/use-async";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorNote } from "@/components/ui/error-note";
import { Select } from "@/components/ui/input";
import { useNear } from "@/wallet/near";
import { readSettlement } from "./read-settlement";
import {
  clearSettlementCall,
  privateBalanceOn,
  SCHEDULES,
  setPrivateCall,
  type Settlement,
} from "./settle";
import type { PayoutSchedule } from "@openrail/api-client";

const ROOT = process.env.NEXT_PUBLIC_ROOT_CONTRACT ?? "openrail.near";

function ScheduleCard() {
  const [biz, reload] = useAsync(() => dashClient.business.get(), []);
  const [choice, setChoice] = useState<PayoutSchedule | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const saved = biz.state === "ready" ? (biz.data.payout?.schedule ?? "manual") : null;
  const value = choice ?? saved ?? "manual";
  const hint = SCHEDULES.find((s) => s.id === value)?.hint;
  return (
    <Card
      title="Payout schedule"
      state={biz.state === "loading" ? "loading" : biz.state === "error" ? "error" : "ready"}
      onRetry={reload}
    >
      <div className="space-y-2">
        <Select
          label="When held payments are sent"
          value={value}
          onValueChange={(v) => {
            setChoice(v as PayoutSchedule);
            setState("idle");
          }}
        >
          {SCHEDULES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <p className="caption">{hint}</p>
        <ErrorNote>{state === "failed" ? "We couldn't save that. Try again." : null}</ErrorNote>
        <div className="flex items-center justify-center gap-3">
          <Button
            disabled={choice === null || choice === saved}
            loading={state === "saving"}
            onClick={async () => {
              if (choice === null) return;
              setState("saving");
              try {
                await dashClient.business.update({ payout: { schedule: choice } });
                setState("saved");
                reload();
              } catch {
                setState("failed");
              }
            }}
          >
            {state === "saving" ? "Saving" : "Save schedule"}
          </Button>
          {state === "saved" ? (
            <span role="status" className="text-[14px] font-medium">
              Saved
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function PrivateBalanceCard({ accountId }: { accountId: string }) {
  const near = useNear();
  const [settlement, setSettlement] = useState<Settlement | null | "error" | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettlement(await readSettlement(ROOT, accountId));
    } catch {
      setSettlement("error");
    }
  }, [accountId]);
  useEffect(() => {
    void load();
  }, [load]);

  const ready = settlement !== "loading" && settlement !== "error";
  const on = ready && privateBalanceOn(settlement, accountId);
  return (
    <Card
      title="Private balance"
      state={settlement === "loading" ? "loading" : settlement === "error" ? "error" : "ready"}
      onRetry={() => void load()}
    >
      <div className="space-y-2">
        <p className="caption">
          {on
            ? "On. Payments of $1 or more are held, then moved into your private balance on your schedule."
            : "Off. Payments go to your public balance."}
        </p>
        <ErrorNote>{failed ? "The change was not signed. Nothing changed." : null}</ErrorNote>
        <div className="flex items-center justify-center">
          <Button
            variant={on ? "secondary" : "primary"}
            loading={busy}
            disabled={!ready}
            onClick={async () => {
              setBusy(true);
              setFailed(false);
              try {
                await near.call(on ? clearSettlementCall(ROOT) : setPrivateCall(ROOT, accountId));
                await load();
              } catch {
                setFailed(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            {on ? "Turn off" : "Turn on"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function PayoutsPanel() {
  const auth = useAuth();
  return (
    <div className="space-y-6">
      <ScheduleCard />
      {auth.state.status === "signedIn" ? (
        <PrivateBalanceCard accountId={auth.state.accountId} />
      ) : null}
    </div>
  );
}
