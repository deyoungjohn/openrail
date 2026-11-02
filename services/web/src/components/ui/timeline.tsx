import { Check, Circle, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { ViewState } from "./card";
import { EmptyState, ErrorState, Skeleton } from "./state";

export interface TimelineStep {
  id: string;
  title: string;
  status: "done" | "current" | "todo" | "failed";
  time?: string;
  /** Usually a TxLink. */
  txs?: ReactNode;
}

export function Timeline({
  steps,
  state = "ready",
  errorBody = "We couldn't load the progress. Reload the page to try again.",
}: {
  steps: readonly TimelineStep[];
  state?: ViewState;
  errorBody?: string;
}) {
  if (state === "loading")
    return (
      <div role="status" aria-busy className="space-y-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  if (state === "error") return <ErrorState body={errorBody} />;
  if (state === "empty" || steps.length === 0)
    return <EmptyState title="No activity yet" body="Steps appear here once a payment starts." />;

  return (
    <ol className="space-y-0">
      {steps.map((s, i) => (
        <li key={s.id} className="relative flex gap-3 pb-6 last:pb-0">
          {i < steps.length - 1 ? (
            <span aria-hidden className="absolute top-7 bottom-0 left-[13px] w-px bg-border" />
          ) : null}
          <span
            className={cn(
              "z-10 grid size-7 shrink-0 place-items-center rounded-full border",
              s.status === "done" && "border-success bg-surface text-success",
              s.status === "current" && "border-accent bg-accent-soft text-accent",
              s.status === "todo" && "border-border bg-surface text-muted",
              s.status === "failed" && "border-danger bg-surface text-danger",
            )}
          >
            {s.status === "done" ? (
              <Check size={16} strokeWidth={1.5} aria-hidden />
            ) : s.status === "current" ? (
              <Loader2 size={16} strokeWidth={1.5} className="animate-spin" aria-hidden />
            ) : s.status === "failed" ? (
              <X size={16} strokeWidth={1.5} aria-hidden />
            ) : (
              <Circle size={12} strokeWidth={1.5} aria-hidden />
            )}
          </span>
          <div className="min-w-0 pt-0.5">
            <p className="text-[14px] leading-5 font-medium">
              {s.title}
              <span className="sr-only"> ({s.status})</span>
            </p>
            {s.time ? <p className="caption">{s.time}</p> : null}
            {s.txs ? <div className="mt-1">{s.txs}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
