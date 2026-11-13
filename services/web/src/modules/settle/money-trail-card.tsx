"use client";

import { useState } from "react";
import { AddressChip } from "@/components/ui/address-chip";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/error-note";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { dashClient } from "@/lib/client";
import { formatUsd } from "@/lib/format";
import { unitsToCents } from "@/lib/earnings";
import { explorerTxUrl } from "@/lib/w5";
import { useAsync } from "@/lib/use-async";
import { useNear } from "@/wallet/near";
import {
  buildTrail,
  trailTotals,
  withdrawalRows,
  type TrailEvent,
  type TrailRow,
  type TrailStage,
  type WithdrawalJson,
} from "./money-trail";
import { ed25519Signature } from "./withdraw";

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
  withdrawn: { label: "Withdrawn", hint: "Sent from your private balance to your wallet." },
};

/** A withdrawal's own word for the table: finished, still moving, or come back. */
function withdrawalLabel(status: string): string {
  if (status === "SUCCESS") return "Withdrawn";
  if (status === "REFUNDED" || status === "FAILED") return "Withdrawal returned";
  return "Withdrawing";
}

type PrivateBalance =
  | { state: "loading" }
  | { state: "locked" }
  | { state: "signing" }
  | { state: "ready"; units: bigint }
  | { state: "error"; message: string };

/**
 * The real private balance, from the provider. Reading it needs a session the merchant signs once (an empty intent with
 * a versioned nonce, prepared by the API); the API keeps the session, so the browser never holds the provider's token.
 */
function usePrivateBalance(): [PrivateBalance, () => void] {
  const near = useNear();
  const [value, setValue] = useState<PrivateBalance>({ state: "loading" });
  const read = async (): Promise<boolean> => {
    try {
      const b = await dashClient.confidential.balance();
      const units = b.balances.reduce(
        (sum, e) => sum + (/^\d+$/.test(e.available) ? BigInt(e.available) : 0n),
        0n,
      );
      setValue({ state: "ready", units });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "confidential_session_required") {
        setValue({ state: "locked" });
        return false;
      }
      setValue({ state: "error", message: "We couldn't read your private balance. Try again." });
      return false;
    }
  };
  // First read on open: a session from earlier (kept by the API until it expires) shows the amount at once.
  useAsync(() => read(), []);
  const unlock = async () => {
    setValue({ state: "signing" });
    try {
      const p = await dashClient.confidential.authPayload();
      const signed = await near.signMessage({
        message: p.payload.message,
        recipient: p.payload.recipient,
        nonce: p.payload.nonce,
      });
      await dashClient.confidential.session({
        standard: p.standard,
        payload: p.payload,
        public_key: signed.publicKey,
        signature: ed25519Signature(signed.signature),
      });
      await read();
    } catch (e) {
      const msg = (e as Error).message ?? "";
      console.error("private balance sign-in failed", e);
      setValue({
        state: "error",
        message: /reject|declin|cancel/i.test(msg)
          ? "You declined it in your wallet."
          : (e as { code?: string }).code === "confidential_auth_failed"
            ? "The provider refused the signature. Check that this wallet key is registered (make one withdrawal first)."
            : "We couldn't open your private balance. Try again.",
      });
    }
  };
  return [value, () => void unlock()];
}

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

function Tile({
  label,
  cents,
  hint,
  children,
}: {
  label: string;
  cents: bigint | null;
  hint: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="surface-card h-full min-h-[128px] p-5">
      <p className="text-[14px] leading-5 font-medium text-muted">{label}</p>
      <p className="tabular mt-2 text-[28px] leading-[1.1] font-bold">
        {cents === null ? "–" : formatUsd(cents)}
      </p>
      <p className="caption mt-1">{hint}</p>
      {children}
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
  const [withdrawals] = useAsync(
    () =>
      dashClient.confidential
        .withdrawals()
        .then((r) => withdrawalRows(r.data as WithdrawalJson[]))
        .catch(() => [] as TrailRow[]),
    [],
  );
  const [privateBalance, unlock] = usePrivateBalance();
  const rows: TrailRow[] = [
    ...(data.state === "ready" ? data.data : []),
    ...(withdrawals.state === "ready" ? withdrawals.data : []),
  ];
  const totals = trailTotals(rows);
  const labelOf = (r: TrailRow) =>
    r.withdrawal ? withdrawalLabel(r.withdrawal.status) : words[r.stage].label;
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
      value: (r) => labelOf(r),
      cell: (r) => <span className="text-[13px] font-medium">{labelOf(r)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Held" cents={cents(totals.held)} hint={words.held.hint} />
        <Tile label="On its way" cents={cents(totals.sending)} hint={words.sending.hint} />
        <Tile
          label="In your private balance"
          cents={privateBalance.state === "ready" ? cents(privateBalance.units) : null}
          hint={
            privateBalance.state === "ready"
              ? "Read from your private balance just now. Only you can see it."
              : "Sign once with your wallet to see the real amount."
          }
        >
          {privateBalance.state === "locked" ||
          privateBalance.state === "signing" ||
          privateBalance.state === "error" ? (
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={unlock}
                disabled={privateBalance.state === "signing"}
              >
                {privateBalance.state === "signing" ? "Waiting for your wallet" : "Show balance"}
              </Button>
              <ErrorNote>
                {privateBalance.state === "error" ? privateBalance.message : null}
              </ErrorNote>
            </div>
          ) : null}
        </Tile>
        <Tile label="Returned" cents={cents(totals.returned)} hint={words.returned.hint} />
      </div>
      <Card title="Where your money is" state="ready" className="p-0">
        <DataTable
          variant="minimal"
          data={rows}
          columns={columns}
          rowId={(r) => r.key}
          caption="Each payment moved to your private balance, each withdrawal from it, and where it is now"
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
          expandedRow={(r) =>
            r.withdrawal ? (
              <dl className="grid gap-x-6 gap-y-3 text-[14px] sm:grid-cols-2">
                <div>
                  <dt className="caption">Last update</dt>
                  <dd className="tabular">{stamp(r.time)}</dd>
                </div>
                <div>
                  <dt className="caption">Sent to</dt>
                  <dd className="font-mono text-[13px] break-all">{r.withdrawal.address}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="caption">Arrival in your wallet</dt>
                  <dd>
                    {r.withdrawal.hashes.length === 0 ? (
                      <span className="caption">Not yet</span>
                    ) : (
                      r.withdrawal.hashes.map((h, i) => {
                        const url =
                          r.withdrawal?.urls[i] ?? explorerTxUrl(r.withdrawal?.chain ?? "", h);
                        return url ? (
                          <a
                            key={h}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="block font-mono text-[13px] underline underline-offset-2"
                          >
                            {`${h.slice(0, 10)}…${h.slice(-6)}`} on the explorer
                          </a>
                        ) : (
                          <span key={h} className="block font-mono text-[13px]">
                            {h}
                          </span>
                        );
                      })
                    )}
                  </dd>
                </div>
              </dl>
            ) : (
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
            )
          }
        />
      </Card>
    </div>
  );
}
