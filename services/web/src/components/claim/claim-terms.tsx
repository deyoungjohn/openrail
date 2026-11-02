import { copy } from "@/copy";
import { formatDate, formatUsdcExact } from "@/lib/format";
import { outstanding, type Claim } from "@/lib/claim";
import { AddressChip } from "../ui/address-chip";
import type { ReactNode } from "react";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-border py-3 first:border-t-0 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-[14px] leading-5 font-medium text-muted">{label}</dt>
      <dd className="min-w-0 text-[15px] leading-6">{children}</dd>
    </div>
  );
}

/** Every term of an invoice, in the order a client reads them. Used before any wallet pop-up. */
export function ClaimTerms({
  claim,
  showOutstanding,
  full,
}: {
  claim: Claim;
  showOutstanding?: boolean;
  /** Print the hash and the account in full, as the ack page must (blueprint 2.7). */
  full?: boolean;
}) {
  const f = copy.fields;
  return (
    <dl>
      <Row label={f.invoice}>
        <code className="font-mono text-[13px]">{claim.invoiceNumber}</code>
      </Row>
      <Row label={f.from}>
        {claim.issuerName} <span className="caption">({claim.issuerId})</span>
      </Row>
      <Row label={f.to}>{claim.debtorName}</Row>
      <Row label={f.amount}>
        <span className="tabular text-[20px] leading-7 font-bold">
          {formatUsdcExact(claim.amountDue)}
        </span>
      </Row>
      {showOutstanding ? (
        <Row label={f.outstanding}>
          <span className="tabular font-medium">{formatUsdcExact(outstanding(claim))}</span>
        </Row>
      ) : null}
      <Row label={f.dueDate}>{formatDate(claim.dueDate)}</Row>
      <Row label={f.termsHash}>
        <AddressChip value={claim.termsHash} head={full ? 66 : 10} tail={full ? 0 : 8} />
      </Row>
      <Row label={f.account}>
        <AddressChip value={claim.claimAccount} head={full ? 64 : 12} tail={full ? 0 : 14} />
      </Row>
    </dl>
  );
}
