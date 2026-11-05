import { AlertTriangle, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { copy } from "@/copy";
import { cn } from "@/lib/cn";
import { Button } from "./button";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton", className)} />;
}

export function EmptyState({
  title = copy.states.emptyTitle,
  body,
  action,
  testId,
}: {
  title?: string;
  body?: string;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-accent-soft text-accent-text">
        <Inbox size={20} strokeWidth={1.5} aria-hidden />
      </span>
      <h3 className="text-[18px] leading-[26px] font-semibold">{title}</h3>
      {body ? <p className="caption max-w-sm">{body}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  title = copy.states.errorTitle,
  body,
  onRetry,
  testId,
}: {
  title?: string;
  body: string;
  onRetry?: () => void;
  testId?: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex flex-col items-center gap-3 px-4 py-12 text-center"
    >
      <span className="text-danger grid size-12 place-items-center rounded-full bg-surface-2">
        <AlertTriangle size={20} strokeWidth={1.5} aria-hidden />
      </span>
      <h3 className="text-[18px] leading-[26px] font-semibold">{title}</h3>
      <p className="caption max-w-sm">{body}</p>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          {copy.states.retry}
        </Button>
      ) : null}
    </div>
  );
}
