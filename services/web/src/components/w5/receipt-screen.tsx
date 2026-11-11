"use client";

import { ApiError } from "@openrail/api-client";
import { copy } from "@/copy";
import { client } from "@/lib/client";
import { formatToken, chainOfRoute } from "@/lib/pay";
import { assetSymbol, explorerTxUrl, formatDateTimeUtc } from "@/lib/w5";
import { useAsync } from "@/lib/use-async";
import { AddressChip } from "../ui/address-chip";
import { Card } from "../ui/card";
import { CHAINS } from "../ui/chain-badge";
import { EmptyState, ErrorState } from "../ui/state";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-border py-3 first:border-t-0 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-[14px] leading-5 font-medium text-muted">{label}</dt>
      <dd className="min-w-0 text-[15px] leading-6">{children}</dd>
    </div>
  );
}

export function ReceiptScreen({ hash }: { hash: string }) {
  const t = copy.receipt;
  const [r, retry] = useAsync(() => client.receipts.getPublic(hash), [hash]);

  if (r.state === "loading") return <Card state="loading" />;
  if (r.state === "error") {
    const none = r.error instanceof ApiError && r.error.status === 404;
    return (
      <div className="surface-card">
        {none ? (
          <EmptyState title={t.notFoundTitle} body={t.notFoundBody} />
        ) : (
          <ErrorState body={t.loadError} onRetry={retry} />
        )}
      </div>
    );
  }

  const { receipt, verify_url, claim_account } = r.data;
  const symbol = assetSymbol(receipt.asset);
  const amount =
    symbol === "USDC" ? `${formatToken(receipt.amount, 6)} USDC` : `${receipt.amount} ${symbol}`;
  // No origin transaction for a payment booked directly on NEAR: the API sends null.
  const origin = receipt.origin_tx as typeof receipt.origin_tx | null;
  const chain = origin ? chainOfRoute({ origin_chain: origin.chain }) : null;
  const chainName = origin ? (chain ? CHAINS[chain] : origin.chain) : null;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-[28px] leading-9 font-bold">{t.title}</h1>
        <p className="tabular text-[36px] leading-[1.1] font-bold">{amount}</p>
      </header>

      <Card>
        <dl>
          <Row label={t.at}>{formatDateTimeUtc(receipt.time)}</Row>
          <Row label={t.invoice}>
            <code className="font-mono text-[13px]">{receipt.claim_number}</code>
          </Row>
          <Row label={t.account}>
            <AddressChip value={claim_account} head={64} tail={0} />
          </Row>
          <Row label={t.fingerprint}>
            <AddressChip value={receipt.terms_hash} head={66} tail={0} />
          </Row>
          <Row label={t.booking}>
            <AddressChip
              value={hash}
              chain="near"
              href={explorerTxUrl("near", hash) ?? undefined}
              tx
            />
          </Row>
          <Row label={t.agreed}>{receipt.payment_instruction_v1}</Row>
        </dl>
      </Card>

      {origin ? (
        <Card title={t.origin}>
          <dl>
            <Row label={t.chain}>{chainName}</Row>
            {origin.sender ? (
              <Row label={t.sender}>
                <AddressChip value={origin.sender} chain={chain ?? undefined} />
              </Row>
            ) : null}
            <Row label={t.transaction}>
              <AddressChip
                value={origin.hash}
                chain={chain ?? undefined}
                href={explorerTxUrl(origin.chain, origin.hash) ?? undefined}
                tx
              />
            </Row>
          </dl>
        </Card>
      ) : null}

      {receipt.near_tx_hashes.length > 0 ? (
        <Card title={t.payout}>
          <ul className="space-y-3">
            {receipt.near_tx_hashes.map((h) => (
              <li key={h}>
                <AddressChip
                  value={h}
                  chain="near"
                  href={explorerTxUrl("near", h) ?? undefined}
                  tx
                />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title={t.verifyTitle}>
        <ol className="list-decimal space-y-2 pl-5 text-[15px]">
          {t.verifySteps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="caption mt-4">{t.verifyNote}</p>
        <p className="mt-3 text-[14px]">
          <a href={verify_url} className="text-accent-text hover:underline">
            {t.verifyLink}
          </a>
        </p>
      </Card>
    </div>
  );
}
