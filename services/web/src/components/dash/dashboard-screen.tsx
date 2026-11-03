"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Bar, BarChart, Cell, Pie, PieChart, XAxis } from "recharts";
import { copy } from "@/copy";
import { dashClient } from "@/lib/client";
import { formatUsd } from "@/lib/format";
import { paymentsByChain, paymentsByMonth, summarize } from "@/lib/invoice-model";
import { formatUsdc } from "@/lib/format";
import { useAsync } from "@/lib/use-async";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { CHAINS } from "../ui/chain-badge";
import { KpiTile } from "../ui/kpi-tile";
import { InvoiceTable } from "./invoice-table";

const CREATE = (
  <Link href="/app/invoices/new">
    <Button icon={<Plus size={18} strokeWidth={1.5} aria-hidden />}>
      {copy.dash.createInvoice}
    </Button>
  </Link>
);

const CHAIN_COLORS = [
  "var(--accent)",
  "var(--info)",
  "var(--success)",
  "var(--warning)",
  "var(--text-muted)",
];

function Payments() {
  const d = copy.dash;
  const [pay, retry] = useAsync(() => dashClient.payments.list(), []);
  const rows = pay.state === "ready" ? pay.data.data : [];
  const chains = paymentsByChain(rows);
  const months = paymentsByMonth(rows);
  const state = pay.state === "ready" ? (chains.length === 0 ? "empty" : "ready") : pay.state;
  const summary = months.map((m) => `${m.month}: ${formatUsdc(m.units)}`).join(", ");

  return (
    <div className="grid items-start gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Card
          title={d.byMonth}
          state={state}
          emptyTitle={d.noPayments}
          emptyBody={d.noPaymentsBody}
          errorBody={d.loadError}
          onRetry={retry}
        >
          <BarChart
            width={560}
            height={200}
            data={months.map((m) => ({ month: m.month, usdc: Number(m.units) / 1_000_000 }))}
            role="img"
            aria-label={summary}
            className="max-w-full"
          >
            <XAxis
              dataKey="month"
              tickLine={false}
              axisLine={false}
              stroke="var(--text-muted)"
              fontSize={12}
            />
            <Bar
              dataKey="usdc"
              fill="var(--accent)"
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
          <p className="caption">{summary}</p>
        </Card>
      </div>
      <Card
        title={d.paidFrom}
        state={state}
        emptyTitle={d.noPayments}
        emptyBody={d.noPaymentsBody}
        errorBody={d.loadError}
        onRetry={retry}
      >
        <ul className="space-y-2">
          {chains.map((c, i) => (
            <li key={c.chain} className="flex items-center gap-2 text-[14px]">
              <span
                aria-hidden
                className="size-2.5 rounded-full"
                style={{ background: CHAIN_COLORS[Math.min(i, CHAIN_COLORS.length - 1)] }}
              />
              <span>{CHAINS[c.chain as keyof typeof CHAINS] ?? c.chain}</span>
              <span className="tabular ml-auto font-medium">{formatUsdc(c.units)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function DashboardScreen() {
  const d = copy.dash;
  const [list, retry] = useAsync(() => dashClient.invoices.list({ limit: 100 }), []);
  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), [list.state]);
  const rows = list.state === "ready" ? list.data.data : [];
  const s = useMemo(() => summarize(rows, nowSec), [rows, nowSec]);
  const tile = list.state === "ready" ? (rows.length === 0 ? "empty" : "ready") : list.state;

  const mix = [
    { name: d.paid, value: s.counts.paid, color: "var(--success)" },
    { name: d.waiting, value: s.counts.waiting, color: "var(--info)" },
    { name: d.overdueLabel, value: s.counts.overdue, color: "var(--danger)" },
  ];
  const mixTotal = mix.reduce((n, m) => n + m.value, 0);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[32px] leading-10 font-bold">{d.title}</h1>
        {CREATE}
      </header>

      {list.state === "ready" && rows.length === 0 ? (
        <div className="surface-card">
          <div className="px-4 py-12 text-center">
            <h2 className="text-[18px] leading-[26px] font-semibold">{d.emptyTitle}</h2>
            <p className="caption mx-auto mt-2 max-w-sm">{d.emptyBody}</p>
            <div className="mt-4 flex justify-center">{CREATE}</div>
          </div>
        </div>
      ) : (
        <>
          <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile label={d.outstanding} cents={s.outstandingCents} state={tile} />
            <KpiTile label={d.collected} cents={s.paidCents} state={tile} />
            <KpiTile label={d.overdue} cents={s.overdueCents} state={tile} />
            <div className="surface-card p-5">
              <p className="text-[14px] leading-5 font-medium text-muted">{d.invoices}</p>
              <p className="tabular mt-2 text-[32px] leading-[1.1] font-bold">
                {list.state === "ready" ? s.counts.all : "–"}
              </p>
            </div>
          </div>

          <div className="grid items-start gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Card
                title={d.latest}
                state={
                  list.state === "error" ? "error" : list.state === "loading" ? "loading" : "ready"
                }
                errorBody={d.loadError}
                onRetry={retry}
              >
                <InvoiceTable caption={d.latest} rows={rows.slice(0, 5)} nowSec={nowSec} />
                <p className="mt-3 text-right text-[14px]">
                  <Link href="/app/invoices" className="text-accent hover:underline">
                    {d.viewAll}
                  </Link>
                </p>
              </Card>
            </div>
            <div className="space-y-4">
              <Card
                title={d.statusMix}
                info={d.statusMixInfo}
                state={list.state === "ready" ? "ready" : list.state}
              >
                <div className="flex items-center gap-4">
                  <PieChart
                    width={120}
                    height={120}
                    role="img"
                    aria-label={mix.map((m) => `${m.name}: ${m.value}`).join(", ")}
                  >
                    <Pie
                      data={
                        mixTotal === 0
                          ? [{ name: "none", value: 1, color: "var(--surface-2)" }]
                          : mix
                      }
                      dataKey="value"
                      innerRadius={36}
                      outerRadius={56}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {(mixTotal === 0 ? [{ color: "var(--surface-2)" }] : mix).map((m, i) => (
                        <Cell key={i} fill={m.color} />
                      ))}
                    </Pie>
                  </PieChart>
                  <ul className="space-y-1.5 text-[14px]">
                    {mix.map((m) => (
                      <li key={m.name} className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="size-2.5 rounded-full"
                          style={{ background: m.color }}
                        />
                        <span>{m.name}</span>
                        <span className="tabular ml-auto font-medium">{m.value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Card>
              <Card
                title={d.topClients}
                state={
                  list.state === "ready"
                    ? s.topClients.length === 0
                      ? "empty"
                      : "ready"
                    : list.state
                }
                emptyBody={d.topClientsEmpty}
              >
                <ul className="divide-y divide-border">
                  {s.topClients.slice(0, 5).map((c) => (
                    <li key={c.name} className="flex items-center gap-3 py-2.5">
                      <span
                        aria-hidden
                        className="grid size-9 place-items-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent"
                      >
                        {c.name.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
                        {c.name}
                      </span>
                      <span className="tabular text-[14px] font-medium">
                        {formatUsd(c.totalCents)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
          <Payments />
        </>
      )}
    </div>
  );
}
