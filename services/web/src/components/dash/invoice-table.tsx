"use client";

import type { Invoice } from "@openrail/api-client";
import { Download } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { copy } from "@/copy";
import { dashClient } from "@/lib/client";
import { chipFor } from "@/lib/invoice-model";
import { formatDueDate } from "@/lib/pay";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import type { ViewState } from "../ui/card";
import { StatusChip } from "../ui/status-chip";
import { Tooltip } from "../ui/tooltip";
import { ErrorNote } from "@/components/ui/error-note";

/** Save the invoice's PDF (the API answers a base64 envelope). */
async function savePdf(id: string, number: string): Promise<void> {
  const doc = (await dashClient.invoices.pdf(id)) as { content_base64?: string; filename?: string };
  if (!doc.content_base64) throw new Error("no pdf");
  const bytes = Uint8Array.from(atob(doc.content_base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = doc.filename ?? `${number}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

export function InvoiceTable({
  rows,
  nowSec,
  state = "ready",
  caption,
  title,
  emptyAction,
  onRetry,
  pageSize = 10,
  searchable = true,
}: {
  rows: readonly Invoice[];
  nowSec: number;
  state?: ViewState;
  caption: string;
  title?: string;
  emptyAction?: React.ReactNode;
  onRetry?: () => void;
  pageSize?: number;
  searchable?: boolean;
}) {
  const d = copy.dash;
  const [failed, setFailed] = useState<string | null>(null);
  const columns: DataTableColumn<Invoice>[] = [
    {
      id: "number",
      header: d.number,
      sortable: true,
      value: (r) => r.invoice_number,
      cell: (r) => (
        <Link
          href={`/app/invoices/${encodeURIComponent(r.id)}`}
          className="font-mono text-[13px] text-accent-text hover:underline"
        >
          {r.invoice_number}
        </Link>
      ),
    },
    { id: "client", header: d.client, sortable: true, value: (r) => r.debtor_legal_name },
    {
      id: "status",
      header: d.status,
      value: (r) => chipFor(r, nowSec, false).kind,
      cell: (r) => (
        <StatusChip
          status={chipFor(r, nowSec, false) as Parameters<typeof StatusChip>[0]["status"]}
        />
      ),
    },
    {
      id: "due",
      header: d.due,
      hideBelow: "sm",
      sortable: true,
      value: (r) => r.due_date,
      cell: (r) => formatDueDate(r.due_date),
    },
    {
      id: "amount",
      header: d.amount,
      sortable: true,
      numeric: true,
      value: (r) => Number(r.amount_usd),
      cell: (r) => `$${r.amount_usd}`,
    },
  ];
  return (
    <div>
      <DataTable
        data={rows}
        columns={columns}
        rowId={(r) => r.id}
        rowLabel={(r) => `invoice ${r.invoice_number}`}
        caption={caption}
        title={title}
        pageSize={pageSize}
        searchable={searchable}
        searchText={(r) => `${r.invoice_number} ${r.debtor_legal_name} ${r.amount_usd}`}
        loading={state === "loading"}
        error={state === "error" ? { body: d.loadError, onRetry } : null}
        emptyState={{ title: d.emptyTitle, body: d.emptyBody, action: emptyAction }}
        rowActions={(r) => (
          <Tooltip label={d.downloadPdfShort} side="left">
            <button
              type="button"
              aria-label={`${d.downloadPdf} ${r.invoice_number}`}
              onClick={() => {
                setFailed(null);
                savePdf(r.id, r.invoice_number).catch(() => setFailed(r.invoice_number));
              }}
              className="grid size-8 place-items-center rounded-xl text-muted transition-colors hover:bg-row hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              <Download aria-hidden size={16} />
            </button>
          </Tooltip>
        )}
      />
      <ErrorNote>{failed ? d.pdfFailed(failed) : null}</ErrorNote>
    </div>
  );
}
