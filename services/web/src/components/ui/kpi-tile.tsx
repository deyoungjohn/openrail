import { ArrowDown, ArrowUp } from "lucide-react";
import { copy } from "@/copy";
import { cn } from "@/lib/cn";
import { usdParts } from "@/lib/format";
import type { ViewState } from "./card";
import { Skeleton } from "./state";

export function KpiTile({
  label,
  cents,
  deltaPct,
  state = "ready",
}: {
  label: string;
  cents?: bigint;
  /** Percent change, signed. 1.5 means +1.5%. */
  deltaPct?: number;
  state?: ViewState;
}) {
  const parts = cents === undefined ? null : usdParts(cents);
  return (
    <div className="surface-card p-5">
      <p className="text-[14px] leading-5 font-medium text-muted">{label}</p>
      {state === "loading" ? (
        <div role="status" aria-busy className="mt-2 space-y-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-5 w-16" />
        </div>
      ) : state === "error" ? (
        <p role="alert" className="mt-2 text-[14px] leading-5">
          <span className="font-medium">{copy.states.errorTitle}.</span>{" "}
          <span className="caption">Try again in a moment.</span>
        </p>
      ) : state === "empty" || !parts ? (
        <p className="tabular mt-2 text-[32px] leading-[1.1] font-bold">
          $0<span className="text-[0.6em] text-muted">.00</span>
        </p>
      ) : (
        <>
          <p className="tabular mt-2 text-[32px] leading-[1.1] font-bold">
            {parts.whole}
            <span className="text-[0.6em] font-bold text-muted">.{parts.cents}</span>
          </p>
          {deltaPct !== undefined ? <Delta pct={deltaPct} /> : null}
        </>
      )}
    </div>
  );
}

function Delta({ pct }: { pct: number }) {
  const up = pct >= 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "mt-2 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[13px] leading-5 font-medium",
        up ? "text-success-text" : "text-danger-text",
      )}
    >
      <Icon size={14} strokeWidth={1.5} aria-hidden />
      <span className="tabular">
        {up ? "+" : ""}
        {pct.toFixed(1)}%
      </span>
    </span>
  );
}
