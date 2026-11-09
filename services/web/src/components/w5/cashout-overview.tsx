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

const shell = "surface-card min-w-0 p-5 sm:p-6";

function Stat({ label, cents, hint }: { label: string; cents: bigint | null; hint: string }) {
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
      <div className="grid items-start gap-4 sm:grid-cols-3">
        <Stat label={t.revenue} cents={loading ? null : f.revenueCents} hint={t.revenueHint} />
        <Stat
          label={t.cashedOut}
          cents={loading ? null : f.cashedOutCents}
          hint={t.cashedOutHint}
        />
        <Stat label={t.kept} cents={loading ? null : f.keptCents} hint={t.keptHint} />
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
