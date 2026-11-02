import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ErrorState, EmptyState, Skeleton } from "./state";

export type ViewState = "ready" | "loading" | "empty" | "error";

export function Card({
  title,
  info,
  action,
  state = "ready",
  emptyTitle,
  emptyBody,
  errorBody = "We couldn't load this. Check your connection and try again.",
  onRetry,
  className,
  children,
}: {
  title?: string;
  info?: string;
  action?: ReactNode;
  state?: ViewState;
  emptyTitle?: string;
  emptyBody?: string;
  errorBody?: string;
  onRetry?: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section aria-label={title || undefined} className={cn("surface-card p-6", className)}>
      {title ? (
        <header className="mb-4 flex items-center gap-2">
          <h3 className="text-[18px] leading-[26px] font-semibold">{title}</h3>
          {info ? (
            <span title={info} className="text-muted">
              <Info size={16} strokeWidth={1.5} aria-label={info} role="img" />
            </span>
          ) : null}
          <div className="ml-auto">{action}</div>
        </header>
      ) : null}
      {state === "loading" ? (
        <div className="space-y-3" role="status" aria-busy>
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : state === "empty" ? (
        <EmptyState title={emptyTitle} body={emptyBody} />
      ) : state === "error" ? (
        <ErrorState body={errorBody} onRetry={onRetry} />
      ) : (
        children
      )}
    </section>
  );
}
