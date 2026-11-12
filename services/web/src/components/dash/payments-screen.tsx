"use client";

import { copy } from "@/copy";
import { CHAINS, ChainIcon, WithIcon, type ChainId } from "@/components/ui/chain-badge";
import { AddressChip } from "@/components/ui/address-chip";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import type { Earning } from "@/lib/earnings";
import { formatUsd } from "@/lib/format";
import { useEarnings } from "@/lib/use-earnings";

const day = (ms: number): string =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(ms));
const stamp = (ms: number): string =>
  `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(ms))} UTC`;

/** Money in, one row per payment: the short facts on the row, the rest in the opened row. */
export function PaymentsScreen() {
  const t = copy.paymentsPage;
  const [data, retry] = useEarnings();
  const rows: Earning[] = data.state === "ready" ? data.data.earnings : [];

  const columns: DataTableColumn<Earning>[] = [
    {
      id: "date",
      header: t.date,
      sortable: true,
      value: (e) => e.time,
      cell: (e) => <span className="tabular whitespace-nowrap">{day(e.time)}</span>,
    },
    {
      id: "amount",
      header: t.amount,
      sortable: true,
      numeric: true,
      value: (e) => Number(e.cents),
      cell: (e) => <span className="tabular font-medium">{formatUsd(e.cents)}</span>,
    },
    {
      id: "from",
      header: t.from,
      value: (e) => e.payer,
      cell: (e) => <span className="block max-w-[16ch] truncate">{e.payer}</span>,
    },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-[32px] leading-10 font-bold">{t.title}</h1>
        <p className="text-[15px]">{t.intro}</p>
      </header>
      <DataTable
        data={rows}
        columns={columns}
        rowId={(e) => e.id}
        rowLabel={(e) => `payment ${e.id}`}
        caption={t.caption}
        pageSize={10}
        defaultSort={{ id: "date", dir: "desc" }}
        loading={data.state === "loading"}
        error={data.state === "error" ? { body: t.loadError, onRetry: retry } : null}
        emptyState={{ title: t.emptyTitle, body: t.emptyBody }}
        expandedRow={(e) => (
          <dl className="grid gap-x-6 gap-y-3 text-[14px] sm:grid-cols-2">
            <div>
              <dt className="caption">{t.time}</dt>
              <dd className="tabular">{stamp(e.time)}</dd>
            </div>
            <div>
              <dt className="caption">{t.source}</dt>
              <dd>{t.streams[e.stream]}</dd>
            </div>
            <div>
              <dt className="caption">{t.network}</dt>
              <dd>
                {CHAINS[e.chain as ChainId] ? (
                  <WithIcon icon={<ChainIcon chain={e.chain as ChainId} />}>
                    {CHAINS[e.chain as ChainId]}
                  </WithIcon>
                ) : (
                  e.chain
                )}
              </dd>
            </div>
            <div>
              <dt className="caption">{t.invoice}</dt>
              <dd>{e.product}</dd>
            </div>
            {e.txHash ? (
              <div className="sm:col-span-2">
                <dt className="caption">{t.transaction}</dt>
                <dd>
                  <AddressChip value={e.txHash} chain={e.chain as ChainId} tx />
                </dd>
              </div>
            ) : null}
          </dl>
        )}
      />
    </div>
  );
}
