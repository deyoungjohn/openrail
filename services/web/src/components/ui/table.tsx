"use client";

import type { ReactNode } from "react";
import { copy } from "@/copy";
import { cn } from "@/lib/cn";
import type { ViewState } from "./card";
import { EmptyState, ErrorState, Skeleton } from "./state";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: "left" | "right";
  /** Hide the label above the value in the mobile card view. */
  hideLabelOnCard?: boolean;
}

export interface TableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  caption: string;
  state?: ViewState;
  emptyTitle?: string;
  emptyBody?: string;
  emptyAction?: ReactNode;
  errorBody?: string;
  onRetry?: () => void;
  /** Pagination footer; omit to hide. */
  page?: { from: number; to: number; total: number; onPrev?: () => void; onNext?: () => void };
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
  state = "ready",
  emptyTitle,
  emptyBody,
  emptyAction,
  errorBody = "We couldn't load this list. Check your connection and try again.",
  onRetry,
  page,
}: TableProps<T>) {
  return (
    <div className="surface-card overflow-hidden">
      {state === "loading" ? (
        <div data-testid="table-loading" role="status" aria-busy className="space-y-px p-4">
          <span className="sr-only">{copy.states.loading}</span>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-[52px] w-full" />
          ))}
        </div>
      ) : state === "empty" ? (
        <EmptyState testId="table-empty" title={emptyTitle} body={emptyBody} action={emptyAction} />
      ) : state === "error" ? (
        <ErrorState testId="table-error" body={errorBody} onRetry={onRetry} />
      ) : (
        <>
          <div className="hidden md:block">
            <table className="w-full border-collapse text-[14px] leading-5">
              <caption className="sr-only">{caption}</caption>
              <thead>
                <tr className="sticky top-0 bg-surface-2">
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      className={cn(
                        "px-4 py-3 text-[14px] font-medium text-muted",
                        c.align === "right" ? "text-right" : "text-left",
                      )}
                    >
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={rowKey(row)}
                    className="h-[52px] border-t border-border transition-colors duration-[var(--dur-fast)] hover:bg-surface-2"
                  >
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={cn(
                          "px-4",
                          c.align === "right" && "tabular text-right font-medium",
                        )}
                      >
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-border md:hidden" aria-label={caption}>
            {rows.map((row) => (
              <li key={rowKey(row)} className="space-y-2 p-4">
                {columns.map((c) => (
                  <div key={c.key} className="flex items-start justify-between gap-4">
                    {c.hideLabelOnCard ? null : (
                      <span className="text-[14px] font-medium text-muted">{c.header}</span>
                    )}
                    <span className={cn("min-w-0", c.align === "right" && "tabular font-medium")}>
                      {c.render(row)}
                    </span>
                  </div>
                ))}
              </li>
            ))}
          </ul>
          {page ? (
            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
              <p className="caption">{copy.table.showing(page.from, page.to, page.total)}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={page.onPrev}
                  disabled={!page.onPrev}
                  className="h-9 rounded-[10px] border border-border bg-surface px-3 text-[14px] font-medium hover:bg-surface-2 disabled:opacity-60"
                >
                  {copy.table.previous}
                </button>
                <button
                  type="button"
                  onClick={page.onNext}
                  disabled={!page.onNext}
                  className="h-9 rounded-[10px] border border-border bg-surface px-3 text-[14px] font-medium hover:bg-surface-2 disabled:opacity-60"
                >
                  {copy.table.next}
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
