"use client";

import { copy } from "@/copy";
import { cn } from "@/lib/cn";
import { tokenLabel, unitsToCents, type CashoutRow } from "@/lib/cashout";
import { formatUsd } from "@/lib/format";
import { AddressChip } from "../ui/address-chip";
import type { ChainId } from "../ui/chain-badge";
import { DataTable, type DataTableColumn } from "../ui/data-table";

const when = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? iso
    : new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(t)) + " UTC";
};

/** Every cash-out of the business: amount, destination, time and the transactions. Not counted on the dashboard. */
export function CashoutHistory({
  rows,
  state,
  onRetry,
}: {
  rows: readonly CashoutRow[];
  state: "loading" | "error" | "ready";
  onRetry: () => void;
}) {
  const t = copy.cashout.history;
  const columns: DataTableColumn<CashoutRow>[] = [
    {
      id: "time",
      header: t.time,
      sortable: true,
      value: (r) => Date.parse(r.created_at),
      cell: (r) => <span className="tabular whitespace-nowrap">{when(r.created_at)}</span>,
    },
    {
      id: "amount",
      header: t.amount,
      sortable: true,
      numeric: true,
      align: "right",
      value: (r) => Number(unitsToCents(r.amount)),
      cell: (r) => (
        <span className="tabular font-medium">
          {formatUsd(unitsToCents(r.amount))}
          <span className="caption block">{tokenLabel(r.source_asset)}</span>
        </span>
      ),
    },
    {
      id: "destination",
      header: t.destination,
      value: (r) => `${r.destination_chain} ${r.destination_address}`,
      cell: (r) => (
        <span className="space-y-1">
          <span className="caption block uppercase">{r.destination_chain}</span>
          <AddressChip value={r.destination_address} chain={r.destination_chain as ChainId} />
        </span>
      ),
    },
    {
      id: "tx",
      header: t.tx,
      hideBelow: "md",
      value: (r) => r.tx_hash ?? "",
      cell: (r) => (
        <span className="space-y-1">
          {r.tx_hash ? (
            <AddressChip value={r.tx_hash} chain="near" />
          ) : (
            <span className="caption">–</span>
          )}
          {r.destination_tx_hashes[0] ? (
            <AddressChip
              value={r.destination_tx_hashes[0]}
              chain={r.destination_chain as ChainId}
            />
          ) : null}
        </span>
      ),
    },
    {
      id: "status",
      header: t.status,
      value: (r) => r.status,
      cell: (r) => (
        <span
          className={cn(
            "text-[13px] font-medium",
            r.status === "success" ? "text-success-text" : "",
            r.status === "failed" || r.status === "incomplete" ? "text-danger-text" : "",
          )}
        >
          {t.statusWord[r.status as keyof typeof t.statusWord] ?? r.status}
        </span>
      ),
    },
  ];
  return (
    <DataTable
      data={rows}
      columns={columns}
      rowId={(r) => r.id}
      rowLabel={(r) => `cash-out ${r.id}`}
      caption={t.caption}
      title={t.title}
      pageSize={8}
      defaultSort={{ id: "time", dir: "desc" }}
      loading={state === "loading"}
      error={state === "error" ? { body: t.loadError, onRetry } : null}
      emptyState={{ title: t.emptyTitle, body: t.emptyBody }}
    />
  );
}
