"use client";

import type { Receipt, WebhookEvent } from "@openrail/api-client";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { copy } from "@/copy";
import { dashClient } from "@/lib/client";
import { formatUsdc, formatUsdcExact } from "@/lib/format";
import { chipFor, claimRows } from "@/lib/invoice-model";
import { chainOfRoute, formatDueDate } from "@/lib/pay";
import { useAsync } from "@/lib/use-async";
import { AddressChip } from "../ui/address-chip";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Countdown } from "../ui/countdown";
import { EmptyState, ErrorState } from "../ui/state";
import { StatusChip } from "../ui/status-chip";
import { useToast } from "../ui/toast";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";

function Payments({ invoiceId }: { invoiceId: string }) {
  const t = copy.detail;
  const [r, retry] = useAsync(() => dashClient.receipts.list(invoiceId), [invoiceId]);
  const rows: Receipt[] = r.state === "ready" ? r.data.data : [];
  return (
    <Card
      title={t.paymentsTitle}
      state={r.state === "ready" ? (rows.length === 0 ? "empty" : "ready") : r.state}
      emptyTitle={t.paymentsEmpty}
      emptyBody={t.paymentsEmptyBody}
      errorBody={t.sectionError}
      onRetry={retry}
    >
      <ul className="divide-y divide-border">
        {rows.map((p) => {
          const chain = chainOfRoute({ origin_chain: p.origin_tx.chain });
          return (
            <li key={p.id} className="space-y-1.5 py-3">
              <p className="text-[14px] font-medium">
                {t.paidIn} <span className="tabular">{formatUsdc(BigInt(p.amount))}</span>
                <span className="caption"> · {when(p.time)}</span>
              </p>
              <p className="caption">{t.yourTx}</p>
              <AddressChip value={p.origin_tx.hash} chain={chain ?? undefined} />
              {p.near_tx_hashes.map((h) => (
                <div key={h}>
                  <p className="caption">{t.payoutTx}</p>
                  <AddressChip value={h} chain="near" />
                </div>
              ))}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function OpenQuotes({ invoiceId }: { invoiceId: string }) {
  const t = copy.detail;
  const [r, retry] = useAsync(() => dashClient.invoices.openQuotes(invoiceId), [invoiceId]);
  const rows = r.state === "ready" ? r.data.data.filter((q) => !q.expired) : [];
  return (
    <Card
      title={t.quotesTitle}
      state={r.state === "ready" ? (rows.length === 0 ? "empty" : "ready") : r.state}
      emptyTitle={t.quotesEmpty}
      emptyBody={t.quotesEmptyBody}
      errorBody={t.sectionError}
      onRetry={retry}
    >
      <ul className="divide-y divide-border">
        {rows.map((q) => (
          <li
            key={q.quote_id}
            className="grid gap-2 py-3 sm:grid-cols-[80px_1fr_auto] sm:items-center"
          >
            <span className="text-[14px] font-medium">{q.route_id}</span>
            <AddressChip value={q.deposit_address} head={8} tail={6} />
            <Countdown expiresAt={q.deadline_requested * 1000} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Events({ invoiceId }: { invoiceId: string }) {
  const t = copy.detail;
  const [r, retry] = useAsync(() => dashClient.events.list({ limit: 50 }), [invoiceId]);
  const rows: WebhookEvent[] =
    r.state === "ready" ? r.data.data.filter((e) => e.data.invoice_id === invoiceId) : [];
  return (
    <Card
      title={t.eventsTitle}
      state={r.state === "ready" ? (rows.length === 0 ? "empty" : "ready") : r.state}
      emptyTitle={t.eventsEmpty}
      emptyBody={t.eventsEmptyBody}
      errorBody={t.sectionError}
      onRetry={retry}
    >
      <ul className="divide-y divide-border">
        {rows.map((e) => (
          <li
            key={e.id}
            className="flex flex-wrap items-center justify-between gap-2 py-3 text-[14px]"
          >
            <code className="font-mono text-[13px]">{e.type}</code>
            <span className="caption">{when(new Date(e.created * 1000).toISOString())}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function InvoiceDetailScreen({ id }: { id: string }) {
  const t = copy.detail;
  const toast = useToast();
  const [r, retry] = useAsync(() => dashClient.invoices.get(id), [id]);
  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), [r.state]);

  if (r.state === "loading") return <Card state="loading" />;
  if (r.state === "error") {
    const notFound = (r.error as { status?: number }).status === 404;
    return (
      <div className="surface-card">
        {notFound ? (
          <EmptyState title={copy.notFound.title} body={copy.notFound.body} />
        ) : (
          <ErrorState body={t.loadError} onRetry={retry} />
        )}
      </div>
    );
  }

  const { invoice, claim } = r.data;
  const chip = chipFor(invoice, nowSec, claim.ack !== null);
  const rows = claimRows(claim);
  const outstanding = rows.find((x) => x.key === "outstanding")!.value;

  return (
    <div className="space-y-6">
      <Link
        href="/app/invoices"
        className="inline-flex items-center gap-1.5 text-[14px] text-muted hover:text-text"
      >
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden />
        {t.back}
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <h1 className="text-[32px] leading-10 font-bold">
            <span className="font-mono text-[28px]">{invoice.invoice_number}</span>
          </h1>
          <div className="flex flex-wrap items-center gap-3">
            <StatusChip
              status={
                (chip.kind === "partial"
                  ? { kind: "partial", due: formatUsdc(outstanding) }
                  : chip) as Parameters<typeof StatusChip>[0]["status"]
              }
            />
            <span className="caption">
              {invoice.debtor_legal_name} · {t.on} {formatDueDate(invoice.due_date)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(invoice.pay_link);
                toast({ tone: "success", title: t.copied });
              } catch {
                toast({ tone: "error", title: "Couldn't copy", body: invoice.pay_link });
              }
            }}
          >
            {t.copyLink}
          </Button>
          <Link href={`/app/invoices/${encodeURIComponent(invoice.token_id)}/transfer`}>
            <Button variant="secondary">{t.sell}</Button>
          </Link>
        </div>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card title={t.moneyTitle} info={t.moneyInfo}>
          <dl>
            {rows.map((row) => (
              <div
                key={row.key}
                className="flex items-baseline justify-between gap-4 border-t border-border py-2.5 first:border-t-0"
              >
                <dt className="text-[14px] font-medium text-muted">{t.counters[row.key]}</dt>
                <dd
                  data-counter={row.key}
                  className={`tabular text-[15px] ${row.key === "outstanding" ? "font-bold" : "font-medium"}`}
                >
                  {formatUsdcExact(row.value)}
                </dd>
              </div>
            ))}
          </dl>
        </Card>

        <div className="space-y-4">
          <Card title={t.accountTitle}>
            <AddressChip value={invoice.claim_account} head={12} tail={14} />
            <p className="caption mt-3">{t.accountBody}</p>
          </Card>
          <Card title={t.ackTitle}>
            {claim.ack ? (
              <StatusChip status={{ kind: "acknowledged" }} />
            ) : (
              <p className="text-[15px]">{t.ackNone}</p>
            )}
            <p className="caption mt-3">{t.ackLink}</p>
            <AddressChip value={invoice.ack_url} head={28} tail={10} />
          </Card>
        </div>
      </div>

      <Payments invoiceId={invoice.id} />
      <OpenQuotes invoiceId={invoice.id} />
      <Events invoiceId={invoice.id} />
    </div>
  );
}
