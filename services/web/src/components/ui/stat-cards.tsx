"use client";

import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatUsd } from "@/lib/format";
import type { OverviewRow } from "@/lib/earnings";
import { copy } from "@/copy";
import { Skeleton } from "./state";
import type { ViewState } from "./card";

const shell = "surface-card min-w-0 p-5 sm:p-6";

function Delta({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-[12px] text-muted">–</span>;
  const up = pct >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className="tabular flex items-center gap-0.5 text-[12px] text-muted">
      <Icon aria-hidden size={13} />
      {up ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

function Loading() {
  return (
    <div role="status" aria-busy className="space-y-3">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

/** This month's money in, against last month, with a line of the last eight weeks. */
export function MonthlyRevenueCard({
  cents,
  deltaPct,
  series,
  state = "ready",
}: {
  cents: bigint;
  deltaPct: number | null;
  series: readonly number[];
  state?: ViewState;
}) {
  const c = copy.statCards;
  const max = Math.max(...series, 1);
  const points = series.map(
    (v, i) => `${(i / Math.max(series.length - 1, 1)) * 100},${28 - (v / max) * 24}`,
  );
  const last = series[series.length - 1] ?? 0;
  return (
    <section className={shell} aria-label={c.monthly}>
      <h3 className="text-[14px] leading-5 font-medium">{c.monthly}</h3>
      {state === "loading" ? (
        <div className="mt-3">
          <Loading />
        </div>
      ) : (
        <>
          <p className="tabular mt-3 text-[28px] leading-8 font-semibold tracking-tight">
            {formatUsd(cents)}
          </p>
          <p className="mt-1 flex items-center gap-1 text-[12px] text-muted">
            {deltaPct === null ? (
              c.noComparison
            ) : (
              <>
                <span className="tabular text-text">
                  {deltaPct >= 0 ? "+" : ""}
                  {deltaPct.toFixed(1)}%
                </span>{" "}
                {c.fromLastMonth}
              </>
            )}
          </p>
          <svg
            viewBox="0 0 100 28"
            preserveAspectRatio="none"
            className="mt-4 h-10 w-full overflow-visible"
            role="img"
            aria-label={c.trend}
          >
            <defs>
              <linearGradient id="stat-area" x1="0" y1="0" x2="0" y2="1">
                <stop stopColor="var(--accent)" stopOpacity="0.25" />
                <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <polygon points={`0,28 ${points.join(" ")} 100,28`} fill="url(#stat-area)" />
            <polyline
              points={points.join(" ")}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx="100" cy={28 - (last / max) * 24} r="2" fill="var(--accent)" />
          </svg>
        </>
      )}
    </section>
  );
}

/** Payments per day over the last seven days. */
export function WeeklyActivityCard({
  days,
  state = "ready",
}: {
  days: readonly { label: string; count: number }[];
  state?: ViewState;
}) {
  const c = copy.statCards;
  const max = Math.max(...days.map((d) => d.count), 1);
  return (
    <section className={shell} aria-label={c.weekly}>
      <h3 className="text-[16px] leading-6 font-semibold">{c.weekly}</h3>
      <p className="caption">{c.weeklySub}</p>
      {state === "loading" ? (
        <div className="mt-4">
          <Loading />
        </div>
      ) : (
        <div
          className="mt-4 flex h-24 items-stretch gap-1.5"
          role="img"
          aria-label={days.map((d) => `${d.label}: ${d.count}`).join(", ")}
        >
          {days.map((d, i) => (
            <div key={i} className="group flex h-full flex-1 flex-col justify-end gap-1.5">
              <div
                title={String(d.count)}
                style={{ height: `${Math.max((d.count / max) * 100, d.count > 0 ? 8 : 3)}%` }}
                className={cn(
                  "w-full rounded-sm bg-gradient-to-t from-accent/25 to-accent/80 opacity-70 transition-opacity group-hover:opacity-100",
                  d.count === 0 && "from-border to-border",
                )}
              />
              <span className="text-center text-[12px] text-muted">{d.label}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Last 30 days against the 30 before. */
export function OverviewCard({
  rows,
  state = "ready",
}: {
  rows: readonly OverviewRow[];
  state?: ViewState;
}) {
  const c = copy.statCards;
  return (
    <section className={shell} aria-label={c.overview}>
      <h3 className="text-[16px] leading-6 font-semibold">{c.overview}</h3>
      <p className="caption">{c.overviewSub}</p>
      {state === "loading" ? (
        <div className="mt-4">
          <Loading />
        </div>
      ) : (
        <dl className="mt-4 space-y-3">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-3">
              <dt className="text-[14px] text-muted">{c.rows[r.key]}</dt>
              <dd className="flex items-center gap-2">
                <span className="tabular text-[14px] font-medium">
                  {r.key === "payments" ? r.value.toString() : formatUsd(r.value)}
                </span>
                <Delta pct={r.deltaPct} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

const initials = (name: string) =>
  name
    .split(/[\s.@_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");

/** The people and companies that paid the most. */
export function TopClientsCard({
  clients,
  state = "ready",
}: {
  clients: readonly { name: string; cents: bigint }[];
  state?: ViewState;
}) {
  const c = copy.statCards;
  return (
    <section className={shell} aria-label={c.clients}>
      <h3 className="text-[16px] leading-6 font-semibold">{c.clients}</h3>
      <p className="caption">{c.clientsSub}</p>
      {state === "loading" ? (
        <div className="mt-4">
          <Loading />
        </div>
      ) : clients.length === 0 ? (
        <p className="caption mt-4">{c.noClients}</p>
      ) : (
        <ol className="mt-3 space-y-1">
          {clients.map((p, i) => (
            <li
              key={p.name}
              className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2 hover:bg-row"
            >
              <span className="tabular w-4 text-[12px] text-muted">{i + 1}</span>
              <span
                aria-hidden
                className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-text"
              >
                {initials(p.name)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px]">{p.name}</span>
              <span className="tabular text-[14px] text-muted">{formatUsd(p.cents)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
