"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { copy } from "@/copy";
import { chipFor, summarize } from "@/lib/invoice-model";
import { lastSevenDays, overview, revenueSummary, topPayers } from "@/lib/earnings";
import { useEarnings } from "@/lib/use-earnings";
import { Button } from "../ui/button";
import { KpiTile } from "../ui/kpi-tile";
import {
  MonthlyRevenueCard,
  OverviewCard,
  TopClientsCard,
  WeeklyActivityCard,
} from "../ui/stat-cards";
import { Tabs } from "../ui/tabs";
import { InvoiceTable } from "./invoice-table";

export function InvoicesScreen() {
  const p = copy.invoicesPage;
  const d = copy.dash;
  const [list, retry] = useEarnings();
  const nowMs = useMemo(() => Date.now(), [list.state]);
  const nowSec = Math.floor(nowMs / 1000);
  const rows = list.state === "ready" ? list.data.invoices : [];
  // These cards show invoices only: this page is about them. The dashboard shows every stream.
  const earnings = useMemo(
    () => (list.state === "ready" ? list.data.earnings.filter((e) => e.stream === "invoice") : []),
    [list],
  );
  const s = useMemo(() => summarize(rows, nowSec), [rows, nowSec]);
  const rev = useMemo(() => revenueSummary(earnings, nowMs), [earnings, nowMs]);
  const week = useMemo(() => lastSevenDays(earnings, nowMs), [earnings, nowMs]);
  const over = useMemo(() => overview(earnings, nowMs), [earnings, nowMs]);
  const clients = useMemo(() => topPayers(earnings, 3), [earnings]);

  const kind = (i: (typeof rows)[number]) => chipFor(i, nowSec, false).kind;
  const by = {
    all: rows,
    paid: rows.filter((i) => i.status === "Paid"),
    waiting: rows.filter((i) => ["sent", "acknowledged", "partial"].includes(kind(i))),
    overdue: rows.filter((i) => kind(i) === "overdue"),
  };
  const state = list.state === "ready" ? "ready" : list.state;
  const cards = list.state === "loading" ? "loading" : "ready";
  const tile = list.state === "ready" ? (rows.length === 0 ? "empty" : "ready") : list.state;
  const table = (r: typeof rows) => (
    <InvoiceTable
      caption={p.title}
      rows={r}
      nowSec={nowSec}
      state={state === "ready" && r.length === 0 ? "empty" : state}
      onRetry={retry}
    />
  );
  const count = (n: number) => (list.state === "ready" ? n : undefined);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[32px] leading-10 font-bold">{p.title}</h1>
        <Link href="/app/invoices/new">
          <Button icon={<Plus size={18} strokeWidth={1.5} aria-hidden />}>
            {copy.dash.createInvoice}
          </Button>
        </Link>
      </header>

      <div className="grid items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MonthlyRevenueCard
          cents={rev.currentCents}
          deltaPct={rev.deltaPct}
          series={rev.series}
          state={cards}
        />
        <WeeklyActivityCard days={week} state={cards} />
        <OverviewCard rows={over} state={cards} />
        <TopClientsCard clients={clients} state={cards} />
      </div>

      <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label={d.outstanding} cents={s.outstandingCents} state={tile} />
        <KpiTile label={d.collected} cents={s.paidCents} state={tile} />
        <KpiTile label={d.overdue} cents={s.overdueCents} state={tile} />
        <div className="surface-card h-full min-h-[128px] p-5">
          <p className="text-[14px] leading-5 font-medium text-muted">{d.invoices}</p>
          <p className="tabular mt-2 text-[32px] leading-[1.1] font-bold">
            {list.state === "ready" ? s.counts.all : "–"}
          </p>
        </div>
      </div>

      <Tabs
        label={p.tabs}
        items={[
          { id: "all", label: p.all, count: count(by.all.length), panel: table(by.all) },
          { id: "paid", label: p.paid, count: count(by.paid.length), panel: table(by.paid) },
          {
            id: "waiting",
            label: p.waiting,
            count: count(by.waiting.length),
            panel: table(by.waiting),
          },
          {
            id: "overdue",
            label: p.overdue,
            count: count(by.overdue.length),
            panel: table(by.overdue),
          },
        ]}
      />
    </div>
  );
}
