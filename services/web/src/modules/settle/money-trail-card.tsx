"use client";

import { AddressChip } from "@/components/ui/address-chip";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { dashClient } from "@/lib/client";
import { formatUsd } from "@/lib/format";
import { unitsToCents } from "@/lib/earnings";
import { useAsync } from "@/lib/use-async";
import {
  buildTrail,
  trailTotals,
  type TrailEvent,
  type TrailRow,
  type TrailStage,
} from "./money-trail";

const TYPES = ["settle_held", "settle_sent", "settle_settled", "settle_refunded"] as const;

/** What "Held" means depends on the schedule: the words must not promise a schedule the merchant did not choose. */
function heldHint(schedule: string | null): string {
  switch (schedule) {
    case "each_payment":
      return "Booked to you. It moves to your private balance within a few minutes.";
    case "daily":
      return "Booked to you. It moves to your private balance once a day.";
    case "weekly":
      return "Booked to you. It moves to your private balance once a week.";
    case "monthly":
      return "Booked to you. It moves to your private balance once a month.";
    case "manual":
      return "Booked to you. Nothing moves until you choose a schedule.";
    default:
      return "Booked to you and waiting to be moved.";
  }
}

const WORDS: Record<TrailStage, { label: string; hint: string }> = {
  held: { label: "Held", hint: "Booked to you and waiting to be moved on your schedule." },
  sending: { label: "On its way", hint: "Being moved to your private balance." },
  private: { label: "In your private balance", hint: "Moved. Only you can see it there." },
  returned: {
    label: "Returned",
    hint: "The move did not complete and the money came back to you.",
  },
};

const day = (ms: number): string =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(ms));
const stamp = (ms: number): string =>
  `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(ms))} UTC`;

async function loadEvents(): Promise<TrailEvent[]> {
  const out: TrailEvent[] = [];
  for (const type of TYPES) {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const batch = await dashClient.events.list({
        type: type as never,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const e of batch.data)
        out.push({
          id: e.id,
          type,
          created: e.created,
          data: (e.data ?? {}) as Record<string, unknown>,
        });
      const next = batch.next_cursor ?? null;
      if (next === null || next === cursor) break;
      cursor = next;
    }
  }
  return out;
}

function Tile({ label, cents, hint }: { label: string; cents: bigint; hint: string }) {
  return (
    <div className="surface-card h-full min-h-[128px] p-5">
      <p className="text-[14px] leading-5 font-medium text-muted">{label}</p>
      <p className="tabular mt-2 text-[28px] leading-[1.1] font-bold">{formatUsd(cents)}</p>
      <p className="caption mt-1">{hint}</p>
    </div>
  );
}

/** Where the money is: held, on its way, in the private balance, or returned. Read from the settle events, no chain call. */
/** The trail of the merchant's held shares, read once for the cards that show it. */
export function useTrail() {
  return useAsync(async () => buildTrail(await loadEvents()), []);
}

export function MoneyTrailCard({ trail }: { trail: ReturnType<typeof useTrail> }) {
  const [data, retry] = trail;
  const [biz] = useAsync(() => dashClient.business.get(), []);
  const schedule = biz.state === "ready" ? (biz.data.payout?.schedule ?? "manual") : null;
  const words: Record<TrailStage, { label: string; hint: string }> = {
    ...WORDS,
    held: { label: WORDS.held.label, hint: heldHint(schedule) },
  };
  const rows: TrailRow[] = data.state === "ready" ? data.data : [];
  const totals = trailTotals(rows);
  const cents = (u: bigint) => unitsToCents(u);

  const columns: DataTableColumn<TrailRow>[] = [
    {
      id: "date",
      header: "Date",
      sortable: true,
      value: (r) => r.time,
      cell: (r) => <span className="tabular whitespace-nowrap">{day(r.time)}</span>,
    },
    {
      id: "amount",
      header: "Amount",
      sortable: true,
      numeric: true,
      value: (r) => Number(r.amount),
      cell: (r) => <span className="tabular font-medium">{formatUsd(cents(r.amount))}</span>,
    },
    {
      id: "where",
      header: "Where it is",
      value: (r) => words[r.stage].label,
      cell: (r) => <span className="text-[13px] font-medium">{words[r.stage].label}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Held" cents={cents(totals.held)} hint={words.held.hint} />
        <Tile label="On its way" cents={cents(totals.sending)} hint={words.sending.hint} />
        <Tile
          label="In your private balance"
          cents={cents(totals.private)}
          hint={words.private.hint}
        />
        <Tile label="Returned" cents={cents(totals.returned)} hint={words.returned.hint} />
      </div>
      <Card title="Where your money is" state="ready" className="p-0">
        <DataTable
          variant="minimal"
          data={rows}
          columns={columns}
          rowId={(r) => r.key}
          caption="Each payment moved to your private balance, and where it is now"
          pageSize={10}
          defaultSort={{ id: "date", dir: "desc" }}
          loading={data.state === "loading"}
          error={
            data.state === "error"
              ? { body: "We couldn't load this. Try again.", onRetry: retry }
              : null
          }
          emptyState={{
            title: "Nothing moved yet",
            body: "When a payment is held or moved to your private balance, it is followed here.",
          }}
          expandedRow={(r) => (
            <dl className="grid gap-x-6 gap-y-3 text-[14px] sm:grid-cols-2">
              <div>
                <dt className="caption">Last step</dt>
                <dd className="tabular">{stamp(r.time)}</dd>
              </div>
              <div>
                <dt className="caption">Order or invoice</dt>
                <dd className="font-mono text-[13px]">{r.tokenId}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="caption">{words[r.stage].hint}</dt>
                <dd>
                  {r.tx ? (
                    <AddressChip value={r.tx} chain="near" tx />
                  ) : (
                    <span className="caption">–</span>
                  )}
                </dd>
              </div>
            </dl>
          )}
        />
      </Card>
    </div>
  );
}
