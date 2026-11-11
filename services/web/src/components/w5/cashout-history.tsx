"use client";

import { copy } from "@/copy";
import { cn } from "@/lib/cn";
import { tokenLabel, unitsToCents, type CashoutRow } from "@/lib/cashout";
import { formatUsd } from "@/lib/format";
import { AddressChip } from "../ui/address-chip";
import type { ChainId } from "../ui/chain-badge";
import { DataTable, type DataTableColumn } from "../ui/data-table";

const day = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? iso
    : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
        new Date(t),
      );
};

/** `4kLxyz…9aBc`: enough to recognise an address; the full one is in the opened row. */
const brief = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

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
      header: t.date,
      sortable: true,
      value: (r) => Date.parse(r.created_at),
      cell: (r) => <span className="tabular whitespace-nowrap">{day(r.created_at)}</span>,
    },
    {
      id: "amount",
      header: t.amount,
      sortable: true,
      numeric: true,
      align: "right",
      value: (r) => Number(unitsToCents(r.amount)),
      cell: (r) => <span className="tabular font-medium">{formatUsd(unitsToCents(r.amount))}</span>,
    },
    {
      id: "destination",
      header: t.destination,
      value: (r) => `${r.destination_chain} ${r.destination_address}`,
      cell: (r) => <span className="font-mono text-[13px]">{brief(r.destination_address)}</span>,
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
      pageSize={10}
      expandedRow={(r) => (
        <dl className="grid gap-x-6 gap-y-3 text-[14px] sm:grid-cols-2">
          <div>
            <dt className="caption">{t.time}</dt>
            <dd className="tabular">{when(r.created_at)}</dd>
          </div>
          <div>
            <dt className="caption">{t.asset}</dt>
            <dd>{tokenLabel(r.source_asset)}</dd>
          </div>
          <div>
            <dt className="caption">{t.chain}</dt>
            <dd>
              {r.destination_chain === "confidential" ? t.privateBalance : r.destination_chain}
            </dd>
          </div>
          <div>
            <dt className="caption">{t.destination}</dt>
            <dd>
              <AddressChip
                value={r.destination_address}
                chain={
                  r.destination_chain === "confidential"
                    ? undefined
                    : (r.destination_chain as ChainId)
                }
              />
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="caption">{t.tx}</dt>
            <dd className="space-y-1">
              {r.tx_hash ? (
                <AddressChip value={r.tx_hash} chain="near" tx />
              ) : (
                <span className="caption">–</span>
              )}
              {r.destination_tx_hashes[0] ? (
                <AddressChip
                  value={r.destination_tx_hashes[0]}
                  chain={r.destination_chain as ChainId}
                  tx
                />
              ) : null}
            </dd>
          </div>
        </dl>
      )}
      defaultSort={{ id: "time", dir: "desc" }}
      loading={state === "loading"}
      error={state === "error" ? { body: t.loadError, onRetry } : null}
      emptyState={{ title: t.emptyTitle, body: t.emptyBody }}
    />
  );
}
