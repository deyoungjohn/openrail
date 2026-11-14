"use client";

import { useCallback, useEffect, useState } from "react";
import { dashClient } from "@/lib/client";
import { useAsync } from "@/lib/use-async";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { ErrorNote } from "@/components/ui/error-note";
import { Select } from "@/components/ui/input";
import { useNear } from "@/wallet/near";
import { MoneyTrailCard, useTrail } from "./money-trail-card";
import { WithdrawCard } from "./withdraw-card";
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
  // What the merchant just signed for, shown at once; cleared when the chain reads the same (14 Nov: the button said
  // "Turn on" after signing until a reload, because the read right after the call still saw the old value).
  const [expected, setExpected] = useState<boolean | null>(null);

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
  const onChain = ready && privateBalanceOn(settlement, accountId);
  const on = expected ?? onChain;
  return (
    <Card
      title="Confidential balance"
      state={settlement === "loading" ? "loading" : settlement === "error" ? "error" : "ready"}
      onRetry={() => void load()}
    >
      <div className="space-y-2">
        <p className="caption">
          {on
            ? "On. Payments of $1 or more are held, then moved into your confidential balance on your schedule."
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
                const want = !on;
                await near.call(on ? clearSettlementCall(ROOT) : setPrivateCall(ROOT, accountId));
                setExpected(want);
                // Read the newest block until it shows the change (a few seconds at most).
                for (let i = 0; i < 12; i += 1) {
                  const now = await readSettlement(ROOT, accountId, "optimistic").catch(
                    () => undefined,
                  );
                  if (now !== undefined && privateBalanceOn(now, accountId) === want) {
                    setSettlement(now);
                    break;
                  }
                  await new Promise((r) => setTimeout(r, 1000));
                }
                setExpected(null);
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

/** Stats: where the money is. Loaded only when the tab is opened (it reads the settle events). */
function StatsPanel() {
  const trail = useTrail();
  return (
    <div className="space-y-6 py-1">
      <MoneyTrailCard trail={trail} />
    </div>
  );
}

/** The confidential balance on the Pay out page: take money out of it, and see where it is. (Its settings are in Settings.) */
export function PayoutsPanel() {
  const auth = useAuth();
  return (
    <div className="space-y-6 py-1">
      <Tabs
        label="Confidential balance"
        items={[
          {
            id: "withdraw",
            label: "Withdraw",
            panel: (
              <div className="space-y-6 py-1">
                {auth.state.status === "signedIn" ? <WithdrawCard /> : null}
              </div>
            ),
          },
          { id: "stats", label: "Stats", panel: <StatsPanel /> },
        ]}
      />
    </div>
  );
}

/** The Payouts tab of Settings: just the two settings (the confidential balance on or off, and the schedule). */
export function PayoutSettingsPanel() {
  const auth = useAuth();
  return (
    <div className="space-y-6">
      {auth.state.status === "signedIn" ? (
        <PrivateBalanceCard accountId={auth.state.accountId} />
      ) : null}
      <ScheduleCard />
    </div>
  );
}
