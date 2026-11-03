"use client";

import type { Invoice } from "@openrail/api-client";
import Link from "next/link";
import { copy } from "@/copy";
import { chipFor } from "@/lib/invoice-model";
import { formatDueDate } from "@/lib/pay";
import { Table, type Column } from "../ui/table";
import type { ViewState } from "../ui/card";
import { StatusChip } from "../ui/status-chip";

export function InvoiceTable({
  rows,
  nowSec,
  state = "ready",
  caption,
  emptyAction,
  onRetry,
}: {
  rows: readonly Invoice[];
  nowSec: number;
  state?: ViewState;
  caption: string;
  emptyAction?: React.ReactNode;
  onRetry?: () => void;
}) {
  const d = copy.dash;
  const columns: Column<Invoice>[] = [
    {
      key: "number",
      header: d.number,
      render: (r) => (
        <Link
          href={`/app/invoices/${encodeURIComponent(r.id)}`}
          className="font-mono text-[13px] text-accent hover:underline"
        >
          {r.invoice_number}
        </Link>
      ),
    },
    { key: "client", header: d.client, render: (r) => r.debtor_legal_name },
    {
      key: "status",
      header: d.status,
      render: (r) => (
        <StatusChip
          status={chipFor(r, nowSec, false) as Parameters<typeof StatusChip>[0]["status"]}
        />
      ),
    },
    { key: "due", header: d.due, render: (r) => formatDueDate(r.due_date) },
    { key: "amount", header: d.amount, align: "right", render: (r) => `$${r.amount_usd}` },
  ];
  return (
    <Table
      caption={caption}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      state={state}
      emptyTitle={copy.dash.emptyTitle}
      emptyBody={copy.dash.emptyBody}
      emptyAction={emptyAction}
      errorBody={copy.dash.loadError}
      onRetry={onRetry}
    />
  );
}
