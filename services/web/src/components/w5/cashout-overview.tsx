"use client";

import { useMemo, useState } from "react";
import { copy } from "@/copy";
import { cn } from "@/lib/cn";
import { figures, monthBars, type CashoutRow } from "@/lib/cashout";
import type { Earning } from "@/lib/earnings";
import { formatUsd } from "@/lib/format";
import { Skeleton } from "../ui/state";

type Range = "30" | "90" | "year";
const DAY = 86_400_000;

const shell = "surface-card h-full min-h-[232px] min-w-0 p-5 sm:p-6";

/** The last months as a small line, zero or more, drawn the way the dashboard's revenue card draws its trend. */
function Spark({ series, color, id }: { series: readonly number[]; color: string; id: string }) {
  const max = Math.max(...series, 1);
  const points = series.map(
    (v, i) => `${(i / Math.max(series.length - 1, 1)) * 100},${28 - (v / max) * 24}`,
  );
  const last = series[series.length - 1] ?? 0;
  return (
    <svg
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      className="mt-4 h-10 w-full overflow-visible"
      aria-hidden
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor={color} stopOpacity="0.25" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,28 ${points.join(" ")} 100,28`} fill={`url(#${id})`} />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx="100" cy={28 - (last / max) * 24} r="2" fill={color} />
    </svg>
  );
}

/** What was left in the balance at the end of each bar: revenue in, cash-outs out, never below zero. */
function keptSeries(bars: readonly { revenue: number; cashedOut: number }[]): number[] {
  let running = 0;
  return bars.map((b) => {
    running = Math.max(0, running + b.revenue - b.cashedOut);
    return running;
  });
}

function Stat({
  label,
  cents,
  hint,
  series,
  color,
  id,
}: {
  label: string;
  cents: bigint | null;
  hint: string;
  series?: readonly number[];
  color?: string;
  id?: string;
}) {
  return (
    <section className={shell} aria-label={label}>
      <h3 className="text-[14px] leading-5 font-medium">{label}</h3>
      {cents === null ? (
        <Skeleton className="mt-3 h-8 w-32" />
      ) : (
        <p className="tabular mt-3 text-[28px] leading-8 font-semibold tracking-tight">
          {formatUsd(cents)}
        </p>
      )}
      <p className="caption mt-1">{hint}</p>
      {series && color && id && cents !== null ? (
        <Spark series={series} color={color} id={id} />
      ) : null}
    </section>
  );
}

/** Revenue, what was cashed out, and what is still in the balance: three figures for a time frame and six months of bars. */
export function CashoutOverview({
  earnings,
  cashouts,
  loading,
}: {
  earnings: readonly Earning[];
  cashouts: readonly CashoutRow[];
  loading: boolean;
}) {
  const t = copy.cashout.overview;
  const [range, setRange] = useState<Range>("30");
  const now = Date.now();
  const window = useMemo(() => {
    const to = now + DAY;
    const from =
      range === "year" ? Date.UTC(new Date(now).getUTCFullYear(), 0, 1) : now - Number(range) * DAY;
    return { from, to };
  }, [range, now]);
  const f = useMemo(() => figures(earnings, cashouts, window), [earnings, cashouts, window]);
  const bars = useMemo(() => monthBars(earnings, cashouts, now), [earnings, cashouts, now]);
  const max = Math.max(1, ...bars.flatMap((b) => [b.revenue, b.cashedOut]));

  return (
    <div className="space-y-4" role="region" aria-label={t.title}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[18px] leading-[26px] font-semibold">{t.title}</h2>
        <div role="group" aria-label={t.range} className="flex flex-wrap items-center gap-1">
          {(["30", "90", "year"] as const).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={cn(
                "h-8 rounded-full px-3 text-[13px] font-medium transition-colors",
                range === r
                  ? "bg-accent text-on-accent"
                  : "bg-surface-2 text-muted hover:text-text",
              )}
            >
              {t.ranges[r]}
            </button>
          ))}
        </div>
      </div>
      <div className="grid items-stretch gap-4 sm:grid-cols-3">
        <Stat
          label={t.revenue}
          cents={loading ? null : f.revenueCents}
          hint={t.revenueHint}
          series={bars.map((b) => b.revenue)}
          color="var(--accent)"
          id="co-revenue"
        />
        <Stat
          label={t.cashedOut}
          cents={loading ? null : f.cashedOutCents}
          hint={t.cashedOutHint}
          series={bars.map((b) => b.cashedOut)}
          color="var(--success)"
          id="co-cashed"
        />
        <Stat
          label={t.kept}
          cents={loading ? null : f.keptCents}
          hint={t.keptHint}
          series={keptSeries(bars)}
          color="var(--warning)"
          id="co-kept"
        />
      </div>
      <section className={shell} aria-label={t.chart}>
        <h3 className="text-[14px] leading-5 font-medium">{t.chart}</h3>
        {loading ? (
          <Skeleton className="mt-4 h-40 w-full" />
        ) : (
          <>
            <svg
              viewBox="0 0 300 120"
              preserveAspectRatio="none"
              className="mt-4 h-40 w-full overflow-visible"
              role="img"
              aria-label={t.chartLabel(
                bars
                  .map((b) => `${b.label}: ${b.revenue.toFixed(2)} / ${b.cashedOut.toFixed(2)}`)
                  .join("; "),
              )}
            >
              <line x1="0" y1="100" x2="300" y2="100" stroke="var(--border)" strokeWidth="1" />
              {bars.map((b, i) => {
                const slot = 300 / bars.length;
                const x = i * slot + slot * 0.15;
                const w = slot * 0.3;
                const h1 = (b.revenue / max) * 92;
                const h2 = (b.cashedOut / max) * 92;
                return (
                  <g key={b.month}>
                    <rect x={x} y={100 - h1} width={w} height={h1} rx="2" fill="var(--accent)" />
                    <rect
                      x={x + w + 2}
                      y={100 - h2}
                      width={w}
                      height={h2}
                      rx="2"
                      fill="var(--success)"
                    />
                    <text
                      x={i * slot + slot / 2}
                      y="115"
                      textAnchor="middle"
                      fontSize="9"
                      fill="var(--muted)"
                    >
                      {b.label}
                    </text>
                  </g>
                );
              })}
            </svg>
            <p className="caption mt-3 flex flex-wrap gap-x-4 gap-y-1">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-2.5 rounded-sm bg-accent" />
                {t.revenue}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-2.5 rounded-sm bg-success" />
                {t.cashedOut}
              </span>
            </p>
          </>
        )}
      </section>
    </div>
  );
}
