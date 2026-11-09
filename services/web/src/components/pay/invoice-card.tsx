import type { PublicClaim } from "@openrail/api-client";
import { copy } from "@/copy";
import { formatDueDate, formatToken } from "@/lib/pay";
import { LineItems, type ShownLineItem } from "../claim/line-items";
import { AddressChip } from "../ui/address-chip";
import { StatusChip, type Status } from "../ui/status-chip";

/** The invoice a payer is about to pay: who it is from, who it is for, what is owed and the terms it carries. */
/**
 * What the API adds for the page when it has it: the lines, the dates and the transactions. Until then the page simply
 * has no such section.
 */
export type PayClaim = PublicClaim & {
  line_items?: readonly ShownLineItem[];
  issued_at?: string;
  paid_at?: string | null;
  issue_tx?: string | null;
  payments?: readonly { tx_hash: string; near?: boolean }[];
};

export function InvoiceCard({ claim: c }: { claim: PayClaim }) {
  const p = copy.pay;
  const paid = c.status === "Paid";
  const partial = c.status === "PartiallyPaid";
  const chip: Status | null = paid
    ? { kind: "paid" }
    : partial
      ? { kind: "partial" }
      : c.status === "Issued"
        ? { kind: "sent" }
        : null;
  const settled = BigInt(c.amount_due) - BigInt(c.outstanding);
  return (
    <section aria-label={p.invoiceCardLabel} className="surface-card overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
        <div>
          <p className="caption uppercase tracking-wide">{p.invoiceWord}</p>
          <h1 className="tabular text-[22px] leading-8 font-bold">{c.invoice_number}</h1>
        </div>
        {chip ? <StatusChip status={chip} /> : null}
      </div>

      <div className="grid gap-5 px-5 py-5 sm:grid-cols-2 sm:px-6">
        <div className="space-y-1">
          <p className="caption">{p.fromLabel}</p>
          <p className="text-[16px] leading-6 font-semibold">{c.issuer_legal_name}</p>
          <AddressChip value={c.terms.issuer_account} />
        </div>
        <div className="space-y-1">
          <p className="caption">{p.billedTo}</p>
          <p className="text-[16px] leading-6 font-semibold">{c.debtor_legal_name}</p>
        </div>
      </div>

      {c.line_items && c.line_items.length > 0 ? (
        <div className="border-t border-border px-5 py-4 sm:px-6">
          <p className="caption mb-1">{p.itemsTitle}</p>
          <LineItems items={c.line_items} />
        </div>
      ) : null}

      <div className="border-y border-border bg-surface-2/40 px-5 py-5 sm:px-6">
        <p className="caption">{partial ? p.stillDue : paid ? p.amountPaid : p.amountDue}</p>
        <p className="tabular text-[40px] leading-[1.1] font-bold">
          {paid ? `$${c.amount_usd}` : `$${formatToken(c.outstanding, 6)}`}
        </p>
        {partial ? (
          <p className="caption mt-1">
            {p.ofInvoice(`$${c.amount_usd}`, `$${formatToken(String(settled), 6)}`)}
          </p>
        ) : null}
        <p className="caption mt-1">{p.due(formatDueDate(c.due_date))}</p>
      </div>

      <dl className="grid gap-x-6 gap-y-4 px-5 py-5 text-[14px] sm:grid-cols-2 sm:px-6">
        <div className="space-y-1">
          <dt className="caption">{p.claimAccountLabel}</dt>
          <dd>
            <AddressChip value={c.claim_account} />
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="caption">{p.fingerprintLabel}</dt>
          <dd>
            <AddressChip value={c.terms_hash} />
          </dd>
        </div>
      </dl>

      <details className="border-t border-border px-5 py-4 text-[14px] sm:px-6">
        <summary className="cursor-pointer font-medium">{p.termsSummary}</summary>
        <ul className="mt-3 list-disc space-y-2 pl-5 leading-5">
          {c.terms.clauses.map((clause) => (
            <li key={clause}>{clause}</li>
          ))}
        </ul>
        <p className="caption mt-3">{p.termsCheck}</p>
      </details>
    </section>
  );
}
