import { copy } from "@/copy";
import { AddressChip } from "../ui/address-chip";
import type { ChainId } from "../ui/chain-badge";
import { Card } from "../ui/card";
import type { PayClaim } from "./invoice-card";

const WHEN = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const when = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${WHEN.format(new Date(t))} UTC`;
};

/**
 * What happened to this invoice, from the day it was issued to the payment: the dates and the transactions that
 * prove them. Shown on a page that has nothing left to pay. Rows appear only for what the API has.
 */
export function HistoryCard({ claim: c }: { claim: PayClaim }) {
  const p = copy.pay;
  const payments = c.payments ?? [];
  const rows: { key: string; label: string; value: string }[] = [];
  if (c.issued_at) rows.push({ key: "issued", label: p.issuedOn, value: when(c.issued_at) });
  if (c.paid_at) rows.push({ key: "paid", label: p.paidOn, value: when(c.paid_at) });
  const hasTx = Boolean(c.issue_tx) || payments.length > 0;
  if (rows.length === 0 && !hasTx) return null;
  return (
    <Card title={p.historyTitle}>
      <dl className="space-y-3 text-[14px]">
        {rows.map((r) => (
          <div key={r.key} className="flex items-baseline justify-between gap-3">
            <dt className="caption">{r.label}</dt>
            <dd className="tabular font-medium">{r.value}</dd>
          </div>
        ))}
        {c.issue_tx ? (
          <div className="space-y-1">
            <dt className="caption">{p.issueTx}</dt>
            <dd>
              <AddressChip value={c.issue_tx} chain="near" tx />
            </dd>
          </div>
        ) : null}
        {payments.map((pay) => (
          <div key={pay.tx_hash} className="space-y-1">
            <dt className="caption">{pay.near ? p.payoutTx : p.originTx}</dt>
            <dd>
              <AddressChip
                value={pay.tx_hash}
                chain={
                  pay.near ? "near" : ((pay as { chain?: string }).chain as ChainId | undefined)
                }
                tx
              />
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
