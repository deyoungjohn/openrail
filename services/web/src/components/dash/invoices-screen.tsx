"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { copy } from "@/copy";
import { dashClient } from "@/lib/client";
import { chipFor } from "@/lib/invoice-model";
import { useAsync } from "@/lib/use-async";
import { Button } from "../ui/button";
import { Tabs } from "../ui/tabs";
import { InvoiceTable } from "./invoice-table";

export function InvoicesScreen() {
  const p = copy.invoicesPage;
  const [list, retry] = useAsync(() => dashClient.invoices.list({ limit: 100 }), []);
  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), [list.state]);
  const rows = list.state === "ready" ? list.data.data : [];
  const kind = (i: (typeof rows)[number]) => chipFor(i, nowSec, false).kind;
  const by = {
    all: rows,
    paid: rows.filter((i) => i.status === "Paid"),
    waiting: rows.filter((i) => ["sent", "acknowledged", "partial"].includes(kind(i))),
    overdue: rows.filter((i) => kind(i) === "overdue"),
  };
  const state = list.state === "ready" ? "ready" : list.state;
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
