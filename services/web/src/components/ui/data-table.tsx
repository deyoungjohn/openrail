"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { copy } from "@/copy";
import { clampPageSize } from "@/lib/table-rows";
import { Pagination } from "./pagination";
import { EmptyState, ErrorState, Skeleton } from "./state";

/**
 * The table every list in the dashboard uses. Its props follow the Spectrum data table
 * (https://ui.spectrumhq.in/docs/data-table): `data`, `columns`, `rowId`, `variant`, `density`, `title`,
 * `totals`, `rowActions`, `onDelete`, `searchable`, `pageSize`, `loading`, `emptyState`, `defaultSort`.
 * Added here: `filters` (one-choice pill groups, for time and stream) and `error`.
 */
export interface DataTableColumn<T> {
  id: string;
  header: string;
  /** What the cell shows; defaults to `value(row)` as text. */
  cell?: (row: T) => ReactNode;
  /** What the column sorts, searches and totals by. */
  value?: (row: T) => string | number | bigint;
  sortable?: boolean;
  numeric?: boolean;
  align?: "left" | "right" | "center";
  width?: string;
  hideBelow?: "sm" | "md" | "lg";
  formatTotal?: (sum: number) => string;
  className?: string;
  headerClassName?: string;
}

export interface DataTableFilter<T> {
  id: string;
  label: string;
  options: { value: string; label: string }[];
  /** True when the row belongs to the chosen value. The first option is "all" and never filters. */
  apply: (row: T, value: string) => boolean;
  defaultValue?: string;
}

export interface DataTableProps<T> {
  data: readonly T[];
  columns: readonly DataTableColumn<T>[];
  rowId: (row: T) => string;
  rowLabel?: (row: T) => string;
  caption?: string;
  title?: string;
  variant?: "panel" | "minimal";
  density?: "compact" | "default" | "relaxed";
  toolbar?: ReactNode;
  /** A control that sits on the first row, just before the search box (a select, for example). */
  leading?: ReactNode;
  searchable?: boolean;
  searchText?: (row: T) => string;
  filters?: readonly DataTableFilter<T>[];
  defaultSort?: { id: string; dir: "asc" | "desc" };
  pageSize?: number;
  loading?: boolean;
  skeletonRows?: number;
  emptyState?: { title: string; body?: string; action?: ReactNode };
  error?: { body?: string; onRetry?: () => void } | null;
  totals?: readonly string[];
  rowActions?: (row: T, helpers: { remove: () => void }) => ReactNode;
  /** The rest of a row's information. A chevron at the end of the row opens it below the row. */
  expandedRow?: (row: T) => ReactNode;
  onDelete?: (ids: string[]) => void;
  onRowClick?: (row: T) => void;
  className?: string;
  /** Columns keep the widths they are given, so sorting never moves them. */
  fixed?: boolean;
}

const HIDE: Record<NonNullable<DataTableColumn<unknown>["hideBelow"]>, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};
const PAD = { compact: "py-2", default: "py-3.5", relaxed: "py-5" } as const;

function compare(a: string | number | bigint, b: string | number | bigint): number {
  if (typeof a === "string" || typeof b === "string") return String(a).localeCompare(String(b));
  return a === b ? 0 : a < b ? -1 : 1;
}

export function DataTable<T>({
  data,
  columns,
  rowId,
  rowLabel,
  caption,
  title,
  variant = "panel",
  density = "default",
  toolbar,
  leading,
  searchable,
  searchText,
  filters = [],
  defaultSort,
  pageSize: askedPageSize,
  loading,
  skeletonRows = 5,
  emptyState,
  error,
  totals = [],
  rowActions,
  expandedRow,
  onDelete,
  onRowClick,
  className,
  fixed,
}: DataTableProps<T>) {
  const t = copy.table;
  // Hard rule: never more than ten rows at once, whatever a screen asks for.
  const pageSize = clampPageSize(askedPageSize);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Rows opened at least once stay mounted (closed) so closing animates too; a row mounts closed and then opens.
  const [everOpened, setEverOpened] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState(defaultSort ?? null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(filters.map((f) => [f.id, f.defaultValue ?? f.options[0]?.value ?? ""])),
  );

  const rows = useMemo(() => {
    let r = data.filter((row) => !removed.has(rowId(row)));
    for (const f of filters) {
      const value = chosen[f.id];
      if (value !== undefined && value !== f.options[0]?.value)
        r = r.filter((row) => f.apply(row, value));
    }
    const q = query.trim().toLowerCase();
    if (q !== "") {
      r = r.filter((row) => {
        const text = searchText
          ? searchText(row)
          : columns.map((c) => (c.value ? String(c.value(row)) : "")).join(" ");
        return text.toLowerCase().includes(q);
      });
    }
    const col = sort ? columns.find((c) => c.id === sort.id) : undefined;
    if (col?.value) {
      const get = col.value;
      const dir = sort?.dir === "desc" ? -1 : 1;
      r = [...r].sort((a, b) => dir * compare(get(a), get(b)));
    }
    return r;
  }, [data, removed, filters, chosen, query, sort, columns, rowId, searchText]);

  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages);
  useEffect(() => setPage(1), [query, chosen, sort]);
  const from = (current - 1) * pageSize;
  const visible = rows.slice(from, from + pageSize);

  const sums = useMemo(() => {
    const out: Record<string, number> = {};
    for (const id of totals) {
      const col = columns.find((c) => c.id === id);
      if (!col?.value) continue;
      out[id] = rows.reduce((n, row) => n + Number(col.value?.(row) ?? 0), 0);
    }
    return out;
  }, [rows, totals, columns]);

  const hasActions = Boolean(rowActions);
  const toggle = (id: string) => {
    if (!everOpened.has(id)) {
      // mounted closed, then opened on the next frame, so the growth is seen
      setEverOpened((prev) => new Set(prev).add(id));
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setOpen((prev) => new Set(prev).add(id))),
      );
      return;
    }
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };
  const hasExpand = Boolean(expandedRow);
  const span = columns.length + (hasActions ? 1 : 0) + (hasExpand ? 1 : 0);
  const shell =
    variant === "panel" ? "surface-card overflow-hidden" : "overflow-hidden border-y border-border";
  const showBar = Boolean(title) || searchable || filters.length > 0 || toolbar || leading;

  return (
    <section className={cn(shell, className)} aria-label={title}>
      {showBar ? (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-3 px-4 pt-4 pb-3 sm:px-6">
          {title ? <h3 className="text-[18px] leading-[26px] font-semibold">{title}</h3> : null}
          {/* The controls sit in one block next to the title: filters and search on the first row, the toolbar
              (time pills, date picker) on the second, every row pushed to the right edge. */}
          <div className="flex min-w-0 flex-1 basis-[28rem] flex-col items-end gap-2">
            <div
              className={cn(
                "flex flex-wrap items-center gap-3",
                leading ? "w-full justify-between" : "justify-end",
              )}
            >
              {leading}
              {filters.map((f) => (
                <div
                  key={f.id}
                  role="group"
                  aria-label={f.label}
                  className="flex flex-wrap items-center gap-1"
                >
                  {f.options.map((o) => {
                    const on = chosen[f.id] === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setChosen((c) => ({ ...c, [f.id]: o.value }))}
                        className={cn(
                          "h-8 rounded-full px-3 text-[13px] font-medium transition-colors",
                          on
                            ? "bg-accent text-on-accent"
                            : "bg-surface-2 text-muted hover:text-text",
                        )}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              ))}
              {searchable ? (
                <label className="relative">
                  <span className="sr-only">{t.search}</span>
                  <Search
                    aria-hidden
                    size={16}
                    className="absolute top-1/2 left-3 -translate-y-1/2 text-muted"
                  />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t.search}
                    className={cn(
                      "w-44 rounded-full border border-border bg-transparent pr-3 pl-9 text-[14px] outline-none focus-visible:border-accent",
                      leading ? "h-11" : "h-9",
                    )}
                  />
                </label>
              ) : null}
            </div>
            {toolbar ? (
              <div className="flex flex-wrap items-center justify-end gap-2">{toolbar}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {loading ? (
        <div
          role="status"
          aria-busy
          className="space-y-px px-4 pb-4 sm:px-6"
          data-testid="table-loading"
        >
          <span className="sr-only">{copy.states.loading}</span>
          {Array.from({ length: skeletonRows }, (_, i) => (
            <Skeleton key={i} className="h-[48px] w-full" />
          ))}
        </div>
      ) : error ? (
        <ErrorState
          testId="table-error"
          body={error.body ?? copy.dash.loadError}
          onRetry={error.onRetry}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          testId="table-empty"
          title={emptyState?.title ?? t.empty}
          body={emptyState?.body}
          action={emptyState?.action}
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table
              className={cn(
                "w-full min-w-[480px] border-collapse text-left text-[14px]",
                fixed && "table-fixed",
              )}
            >
              {caption ? <caption className="sr-only">{caption}</caption> : null}
              <thead>
                <tr className="border-y border-border text-[12px] font-medium text-muted">
                  {columns.map((c) => {
                    const active = sort?.id === c.id;
                    const align =
                      c.numeric || c.align === "right"
                        ? "text-right"
                        : c.align === "center"
                          ? "text-center"
                          : "";
                    return (
                      <th
                        key={c.id}
                        scope="col"
                        style={c.width ? { width: c.width } : undefined}
                        aria-sort={
                          active ? (sort?.dir === "asc" ? "ascending" : "descending") : undefined
                        }
                        className={cn(
                          "px-4 py-2.5 font-medium first:sm:pl-6",
                          align,
                          c.hideBelow && HIDE[c.hideBelow],
                          c.headerClassName,
                        )}
                      >
                        {c.sortable ? (
                          <button
                            type="button"
                            onClick={() =>
                              setSort(
                                active && sort?.dir === "asc"
                                  ? { id: c.id, dir: "desc" }
                                  : { id: c.id, dir: "asc" },
                              )
                            }
                            className={cn(
                              "inline-flex items-center gap-1 hover:text-text",
                              c.numeric && "flex-row-reverse",
                            )}
                          >
                            {c.header}
                            {active ? (
                              sort?.dir === "asc" ? (
                                <ArrowUp aria-hidden size={13} />
                              ) : (
                                <ArrowDown aria-hidden size={13} />
                              )
                            ) : (
                              <ArrowUpDown aria-hidden size={13} className="opacity-50" />
                            )}
                          </button>
                        ) : (
                          c.header
                        )}
                      </th>
                    );
                  })}
                  {hasActions ? (
                    <th scope="col" className="w-12 px-4 py-2.5" aria-label={t.actions} />
                  ) : null}
                  {hasExpand ? (
                    <th scope="col" className="w-12 px-2 py-2.5" aria-label={t.details} />
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const id = rowId(row);
                  const isOpen = open.has(id);
                  return (
                    <Fragment key={id}>
                      <tr
                        aria-label={rowLabel?.(row)}
                        onClick={(e) => {
                          onRowClick?.(row);
                          // A row that opens opens from anywhere in it, except from a control inside it (a link, a button).
                          if (
                            hasExpand &&
                            !(e.target as HTMLElement).closest(
                              "a,button,input,select,textarea,[role=button]",
                            )
                          )
                            toggle(rowId(row));
                        }}
                        className={cn(
                          "border-b border-border last:border-b-0 hover:bg-row",
                          (onRowClick || hasExpand) && "cursor-pointer",
                        )}
                      >
                        {columns.map((c) => {
                          const align =
                            c.numeric || c.align === "right"
                              ? "text-right tabular"
                              : c.align === "center"
                                ? "text-center"
                                : "";
                          return (
                            <td
                              key={c.id}
                              className={cn(
                                "px-4 first:sm:pl-6",
                                PAD[density],
                                align,
                                c.hideBelow && HIDE[c.hideBelow],
                                c.className,
                              )}
                            >
                              {c.cell ? c.cell(row) : c.value ? String(c.value(row)) : null}
                            </td>
                          );
                        })}
                        {hasActions ? (
                          <td className={cn("px-4 text-right", PAD[density])}>
                            {rowActions?.(row, {
                              remove: () => {
                                setRemoved((s) => new Set(s).add(id));
                                onDelete?.([id]);
                              },
                            })}
                          </td>
                        ) : null}
                        {hasExpand ? (
                          <td className={cn("px-2 text-right", PAD[density])}>
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              aria-label={isOpen ? t.hideDetails : t.showDetails}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle(id);
                              }}
                              className="text-text-muted hover:text-text inline-flex size-8 items-center justify-center rounded-full"
                            >
                              <ChevronDown
                                aria-hidden
                                size={16}
                                className={cn(
                                  "transition-transform duration-300 ease-[var(--ease)]",
                                  isOpen && "rotate-180",
                                )}
                              />
                            </button>
                          </td>
                        ) : null}
                      </tr>
                      {hasExpand && (isOpen || everOpened.has(id)) ? (
                        <tr
                          className={cn(
                            "bg-row/50",
                            isOpen && "border-b border-border last:border-b-0",
                          )}
                        >
                          <td colSpan={span} className="p-0">
                            {/* Opens and closes by growing the row: grid rows go 0fr -> 1fr, the content fades. */}
                            <div
                              data-open={isOpen}
                              className="grid [grid-template-rows:0fr] transition-[grid-template-rows,opacity] duration-300 ease-[var(--ease)] data-[open=true]:[grid-template-rows:1fr] opacity-0 data-[open=true]:opacity-100 motion-reduce:transition-none"
                            >
                              <div className="min-h-0 overflow-hidden">
                                <div className="px-4 py-3 first:sm:pl-6">{expandedRow?.(row)}</div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
              {Object.keys(sums).length > 0 ? (
                <tfoot>
                  <tr className="border-t border-border font-medium">
                    {columns.map((c, i) => (
                      <td
                        key={c.id}
                        className={cn(
                          "px-4 py-3 first:sm:pl-6",
                          c.numeric && "text-right tabular",
                          c.hideBelow && HIDE[c.hideBelow],
                        )}
                      >
                        {i === 0 && sums[c.id] === undefined
                          ? t.total
                          : sums[c.id] !== undefined
                            ? (c.formatTotal ?? String)(sums[c.id] as number)
                            : null}
                      </td>
                    ))}
                    {hasActions ? <td /> : null}
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
          {pages > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-6">
              <p className="caption" aria-live="polite">
                {t.showing(from + 1, Math.min(from + pageSize, rows.length), rows.length)}
              </p>
              <Pagination
                totalPages={pages}
                page={current}
                onPageChange={setPage}
                aria-label={t.pagination}
              />
            </div>
          ) : (
            <p className="caption px-4 py-3 sm:px-6">{t.count(rows.length)}</p>
          )}
        </>
      )}
    </section>
  );
}
