"use client";

import { useState } from "react";
import { copy } from "@/copy";
import { cn } from "@/lib/cn";
import { formatNear, MIN_DEPOSIT_YOCTO, parseNear } from "@/lib/near-amount";
import { useActions } from "@/wallet/actions";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** Quick amounts, in NEAR. The smallest is the minimum deposit: about one invoice's storage. */
const PRESETS = ["0.02", "0.1", "0.5", "1"] as const;

/**
 * Deposit storage credit: any amount from 0.02 NEAR, with a few quick amounts. One wallet signature. The parent
 * reloads the balance when the deposit is sent.
 */
export function DepositControl({
  contractId,
  suggestedYocto,
  onSent,
}: {
  contractId: string;
  /** What the API suggests; the field starts there. */
  suggestedYocto: string;
  onSent: () => void;
}) {
  const t = copy.setup;
  const actions = useActions();
  const [text, setText] = useState(formatNear(BigInt(suggestedYocto)).replace(/,/g, ""));
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const yocto = parseNear(text);
  const tooSmall = yocto !== null && yocto < MIN_DEPOSIT_YOCTO;
  const invalid = yocto === null || tooSmall;
  const problem =
    text.trim() === ""
      ? undefined
      : yocto === null
        ? t.depositBad
        : tooSmall
          ? t.depositMin
          : undefined;

  return (
    <div className="space-y-3">
      <div role="group" aria-label={t.depositQuick} className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={parseNear(text) === parseNear(p)}
            onClick={() => {
              setText(p);
              setState("idle");
            }}
            className={cn(
              "h-8 rounded-full px-3 text-[13px] font-medium transition-colors",
              parseNear(text) === parseNear(p)
                ? "bg-accent text-on-accent"
                : "bg-surface-2 text-muted hover:text-text",
            )}
          >
            {p} NEAR
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div className="w-44">
          <Input
            label={t.depositAmount}
            inputMode="decimal"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setState("idle");
            }}
            error={problem}
          />
        </div>
        <Button
          variant="secondary"
          loading={state === "sending"}
          disabled={invalid}
          onClick={async () => {
            if (yocto === null || tooSmall) return;
            setState("sending");
            try {
              await actions.depositStorageCredit(contractId, yocto.toString());
              setState("sent");
              onSent();
            } catch {
              setState("failed");
            }
          }}
        >
          {t.creditDeposit}
        </Button>
      </div>
      {state === "sent" ? (
        <p role="status" className="text-[14px]">
          {t.creditSent}
        </p>
      ) : null}
      {state === "failed" ? (
        <p role="alert" className="text-danger-text text-[14px]">
          {t.creditFailed}
        </p>
      ) : null}
    </div>
  );
}
