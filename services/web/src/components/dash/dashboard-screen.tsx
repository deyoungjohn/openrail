"use client";

import { Receipt } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Cell, Pie, PieChart } from "recharts";
import { copy } from "@/copy";
import { cn } from "@/lib/cn";
import {
  byChain,
  byMonth,
  byStream,
  inDayRange,
  lastSevenDays,
  overview,
  revenueSummary,
  topPayers,
  type Earning,
  type Stream,
} from "@/lib/earnings";
import { formatUsd } from "@/lib/format";
import { useEarnings } from "@/lib/use-earnings";
import { Card } from "../ui/card";
import { CHAINS } from "../ui/chain-badge";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { DateRangeField, rangePresets, type DateRange } from "../ui/date-range-field";
import {
  MonthlyRevenueCard,
  OverviewCard,
  TopClientsCard,
  WeeklyActivityCard,
} from "../ui/stat-cards";
import { Tooltip } from "../ui/tooltip";
import { BalanceButton } from "./balance-card";

const STREAM_COLOR: Record<Stream, string> = {
  invoice: "var(--accent)",
  checkout: "var(--info)",
  pay_link: "var(--success)",
};

const when = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function updatedAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ago`;
}

function StreamChip({ stream }: { stream: Stream }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[12px] font-medium">
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ background: STREAM_COLOR[stream] }}
      />
      {copy.dash.streamLabels[stream]}
    </span>
  );
}

function Pills<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-8 rounded-full px-3 text-[13px] font-medium transition-colors",
            value === o.value
              ? "bg-accent text-on-accent"
              : "bg-surface-2 text-muted hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const streamOptions: { value: Stream | "all"; label: string }[] = [
  { value: "all", label: copy.dash.allStreams },
  { value: "invoice", label: copy.dash.streamLabels.invoice },
  { value: "checkout", label: copy.dash.streamLabels.checkout },
  { value: "pay_link", label: copy.dash.streamLabels.pay_link },
];

function Collections({ earnings }: { earnings: readonly Earning[] }) {
  const d = copy.dash;
  const [range, setRange] = useState<DateRange | null>(null);
  const [stream, setStream] = useState<Stream | "all">("all");
  const filtered = useMemo(
    () =>
      earnings.filter(
        (e) => inDayRange(e.time, range) && (stream === "all" || e.stream === stream),
      ),
    [earnings, range, stream],
  );
  const months = useMemo(() => byMonth(filtered).reverse(), [filtered]);
  const chains = useMemo(() => byChain(filtered), [filtered]);

  const monthCols: DataTableColumn<(typeof months)[number]>[] = [
    { id: "month", header: d.month, sortable: true, value: (r) => r.month },
    {
      id: "cents",
      header: d.amount,
      sortable: true,
      numeric: true,
      value: (r) => Number(r.cents),
      cell: (r) => formatUsd(r.cents),
      formatTotal: (n) => formatUsd(BigInt(Math.round(n))),
    },
  ];
  const chainCols: DataTableColumn<(typeof chains)[number]>[] = [
    {
      id: "chain",
      header: d.network,
      sortable: true,
      value: (r) => CHAINS[r.chain as keyof typeof CHAINS] ?? r.chain,
    },
    {
      id: "count",
      header: d.payments,
      sortable: true,
      numeric: true,
      hideBelow: "sm",
      value: (r) => r.count,
    },
    {
      id: "cents",
      header: d.amount,
      sortable: true,
      numeric: true,
      value: (r) => Number(r.cents),
      cell: (r) => formatUsd(r.cents),
      formatTotal: (n) => formatUsd(BigInt(Math.round(n))),
    },
  ];
  const empty = { title: d.noPayments, body: d.noPaymentsBody };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <DateRangeField
          label={d.timeFilter}
          value={range}
          onChange={setRange}
          placeholder={d.allTime}
        />
        <Pills label={d.streamFilter} value={stream} options={streamOptions} onChange={setStream} />
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <DataTable
          data={months}
          columns={monthCols}
          rowId={(r) => r.month}
          title={d.byMonth}
          caption={d.byMonth}
          totals={["cents"]}
          pageSize={6}
          emptyState={empty}
        />
        <DataTable
          data={chains}
          columns={chainCols}
          rowId={(r) => r.chain}
          title={d.paidFrom}
          caption={d.paidFrom}
          totals={["cents"]}
          pageSize={6}
          emptyState={empty}
        />
      </div>
    </div>
  );
}

function Activity({ earnings }: { earnings: readonly Earning[] }) {
  const d = copy.dash;
  const [range, setRange] = useState<DateRange | null>(null);
  const shown = useMemo(() => earnings.filter((e) => inDayRange(e.time, range)), [earnings, range]);
  const quick = useMemo(
    () => rangePresets().map((p, i) => ({ short: d.periodShort[i] as string, value: p.value })),
    [d],
  );
  const columns: DataTableColumn<Earning>[] = [
    { id: "payer", header: d.payer, sortable: true, value: (r) => r.payer },
    {
      id: "product",
      header: d.product,
      hideBelow: "sm",
      sortable: true,
      value: (r) => r.product,
      cell: (r) => (
        <Link
          href={`/app/invoices/${encodeURIComponent(r.invoiceId)}`}
          className="text-accent-text hover:underline"
        >
          {r.product}
        </Link>
      ),
    },
    {
      id: "stream",
      header: d.stream,
      hideBelow: "md",
      value: (r) => r.stream,
      cell: (r) => <StreamChip stream={r.stream} />,
    },
    {
      id: "chain",
      header: d.network,
      hideBelow: "lg",
      value: (r) => CHAINS[r.chain as keyof typeof CHAINS] ?? r.chain,
    },
    {
      id: "time",
      header: d.time,
      sortable: true,
      value: (r) => r.time,
      cell: (r) => (r.time > 0 ? when.format(r.time) : "—"),
    },
    {
      id: "cents",
      header: d.amount,
      sortable: true,
      numeric: true,
      value: (r) => Number(r.cents),
      cell: (r) => formatUsd(r.cents),
    },
  ];
  return (
    <DataTable
      data={shown}
      columns={columns}
      rowId={(r) => r.id}
      rowLabel={(r) => `${r.payer}, ${r.product}`}
      toolbar={
        <>
          <div
            role="group"
            aria-label={d.periodFilter}
            className="flex flex-wrap items-center gap-1"
          >
            {quick.map((q) => {
              const on = range?.from === q.value.from && range?.to === q.value.to;
              return (
                <button
                  key={q.short}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setRange(on ? null : q.value)}
                  className={cn(
                    "h-8 rounded-full px-3 text-[13px] font-medium transition-colors",
                    on ? "bg-accent text-on-accent" : "bg-surface-2 text-muted hover:text-text",
                  )}
                >
                  {q.short}
                </button>
              );
            })}
          </div>
          <DateRangeField
            label={d.timeFilter}
            value={range}
            onChange={setRange}
            placeholder={d.allTime}
            triggerClassName="w-60 justify-start"
          />
        </>
      }
      title={d.activity}
      caption={d.activity}
      defaultSort={{ id: "time", dir: "desc" }}
      pageSize={8}
      searchable
      filters={[
        {
          id: "stream",
          label: d.streamFilter,
          options: streamOptions,
          apply: (r, v) => r.stream === v,
        },
      ]}
      emptyState={{ title: d.activityEmpty, body: d.activityEmptyBody }}
      rowActions={(r) => (
        <Tooltip label="Receipt" side="left">
          <Link
            href={`/r/${encodeURIComponent(r.txHash)}`}
            aria-label={`Receipt for ${r.product}`}
            className="grid size-8 place-items-center rounded-xl text-muted transition-colors hover:bg-row hover:text-text"
          >
            <Receipt aria-hidden size={16} />
          </Link>
        </Tooltip>
      )}
    />
  );
}

function Streams({
  earnings,
  failedStreams,
}: {
  earnings: readonly Earning[];
  failedStreams: readonly Stream[];
}) {
  const d = copy.dash;
  const data = byStream(earnings);
  const total = data.reduce((n, s) => n + s.cents, 0n);
  const label = data.map((s) => `${d.streamLabels[s.stream]}: ${formatUsd(s.cents)}`).join(", ");
  return (
    <Card title={d.streamsTitle} info={d.streamsInfo}>
      <div className="flex items-center gap-4">
        <PieChart width={120} height={120} role="img" aria-label={label}>
          <Pie
            data={
              total === 0n
                ? [{ stream: "none", value: 1, color: "var(--surface-2)" }]
                : data.map((s) => ({
                    stream: s.stream,
                    value: Number(s.cents),
                    color: STREAM_COLOR[s.stream],
                  }))
            }
            dataKey="value"
            innerRadius={36}
            outerRadius={56}
            stroke="none"
            isAnimationActive={false}
          >
            {(total === 0n
              ? [{ color: "var(--surface-2)" }]
              : data.map((s) => ({ color: STREAM_COLOR[s.stream] }))
            ).map((m, i) => (
              <Cell key={i} fill={m.color} />
            ))}
          </Pie>
        </PieChart>
        {failedStreams.length > 0 ? (
          <p className="text-[12px] text-muted">Some payment sources could not be loaded.</p>
        ) : null}
        <ul className="space-y-1.5 text-[14px]">
          {data.map((s) => (
            <li key={s.stream} className="flex items-center gap-2">
              <span
                aria-hidden
                className="size-2.5 rounded-full"
                style={{ background: STREAM_COLOR[s.stream] }}
              />
              <span>{d.streamLabels[s.stream]}</span>
              <span className="tabular ml-auto pl-3 font-medium">{formatUsd(s.cents)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export function DashboardScreen() {
  const d = copy.dash;
  const [load, retry] = useEarnings();
  // When the indexer says it is boosting, refetch once after a minute so a payment just booked appears.
  const refetchedForBoost = useRef(false);
  const boostActive = load.state === "ready" ? load.data.meta?.boost_active === true : false;
  useEffect(() => {
    if (!boostActive || refetchedForBoost.current) return;
    refetchedForBoost.current = true;
    const timer = setTimeout(retry, 60_000);
    return () => clearTimeout(timer);
  }, [boostActive, retry]);
  const nowMs = useMemo(() => Date.now(), [load.state]);
  const earnings = load.state === "ready" ? load.data.earnings : [];
  const loading = load.state === "loading";
  const rev = useMemo(() => revenueSummary(earnings, nowMs), [earnings, nowMs]);
  const week = useMemo(() => lastSevenDays(earnings, nowMs), [earnings, nowMs]);
  const over = useMemo(() => overview(earnings, nowMs), [earnings, nowMs]);
  const clients = useMemo(() => topPayers(earnings, 3), [earnings]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[32px] leading-10 font-bold">{d.title}</h1>
          {load.state === "ready" ? (
            <p className="text-[12px] text-muted">
              {load.data.meta?.last_polled_at
                ? `Updated ${updatedAgo(load.data.meta.last_polled_at)}`
                : "Updated —"}
            </p>
          ) : null}
        </div>
        <BalanceButton />
      </header>

      {load.state === "error" ? (
        <Card state="error" errorBody={d.loadError} onRetry={retry} />
      ) : (
        <>
          <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MonthlyRevenueCard
              cents={rev.currentCents}
              deltaPct={rev.deltaPct}
              series={rev.series}
              state={loading ? "loading" : "ready"}
            />
            <WeeklyActivityCard days={week} state={loading ? "loading" : "ready"} />
            <OverviewCard rows={over} state={loading ? "loading" : "ready"} />
            <TopClientsCard clients={clients} state={loading ? "loading" : "ready"} />
          </div>

          <div className="grid items-start gap-4 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2">
              {loading ? (
                <DataTable data={[]} columns={[]} rowId={() => ""} title={d.activity} loading />
              ) : (
                <Activity earnings={earnings} />
              )}
            </div>
            <div className="min-w-0">
              {loading ? (
                <Card title={d.streamsTitle} state="loading" />
              ) : (
                <Streams
                  earnings={earnings}
                  failedStreams={load.state === "ready" ? load.data.failedStreams : []}
                />
              )}
            </div>
          </div>

          {loading ? null : <Collections earnings={earnings} />}
        </>
      )}
    </div>
  );
}
