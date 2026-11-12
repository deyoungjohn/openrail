"use client";

import { ApiError, type PaySession, type Route } from "@openrail/api-client";
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock } from "lucide-react";
import { HistoryCard } from "@/components/pay/history-card";
import type { PayClaim } from "@/components/pay/invoice-card";
import { PayScreen, type PayFlowClaim, type PayScreenSource } from "@/components/pay/pay-screen";
import { AddressChip } from "@/components/ui/address-chip";
import { Countdown } from "@/components/ui/countdown";
import { latchStatus, type CheckoutStatus } from "./checkout";
import { StatusChip, type Status } from "@/components/ui/status-chip";
import { copy } from "@/copy";
import { formatToken, type PayStage } from "@/lib/pay";
import {
  canQuoteCheckout,
  checkoutCopy,
  checkoutLiveBanner,
  checkoutPayWords,
  countdownTargetMs,
  safeReturnUrl,
  type LiveBanner,
  type PublicCheckout,
} from "./checkout";

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const POLL_MS = 3000;

export interface PublicCheckoutPayload extends PublicCheckout {
  routes?: Route[];
  sessions?: PaySession[];
  /** The dates and transactions of a checkout that is not open any more (what an invoice's page also shows). */
  history?: {
    issued_at: string;
    paid_at: string | null;
    issue_tx: string | null;
    payments: { tx_hash: string; near: boolean }[];
  };
}

async function fetchCheckout(id: string): Promise<PublicCheckoutPayload> {
  const response = await fetch(`${API_URL}/v1/public/checkouts/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) throw new ApiError(404, { error: { code: "checkout_not_found" } });
  if (!response.ok) throw new ApiError(response.status, { error: { code: "load_failed" } });
  return (await response.json()) as PublicCheckoutPayload;
}

/** A summary card on top of the checkout: merchant, order reference, amount, expiry countdown, and live status. */
function CheckoutCard({
  checkout: c,
  effectiveCheckout,
  expiryMs,
  banner,
  returnHref,
  cancelHref,
  received,
}: {
  received?: boolean;
  checkout: PublicCheckoutPayload;
  effectiveCheckout: PublicCheckout;
  expiryMs: number;
  banner: LiveBanner;
  returnHref: string | null;
  cancelHref?: string | null;
}) {
  const p = copy.pay;
  // `received`: the whole amount has arrived but is not booked on chain yet; the tag already says Paid (it said
  // "Waiting for payment" next to ticked steps).
  const paid =
    received === true ||
    effectiveCheckout.status === "paid" ||
    effectiveCheckout.status === "accepted";
  const partial = effectiveCheckout.status === "partial";
  const chip: Status | null = paid
    ? { kind: "paid" }
    : partial
      ? { kind: "partial", due: `$${formatToken(effectiveCheckout.outstanding, 6)}` }
      : effectiveCheckout.status === "late" || effectiveCheckout.status === "needs_attention"
        ? { kind: "late" }
        : effectiveCheckout.status === "expired"
          ? { kind: "closed" }
          : { kind: "sent" };
  const settled = BigInt(c.amount_due || "0") - BigInt(c.outstanding || "0");

  return (
    <section aria-label="Checkout" className="surface-card overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="caption uppercase tracking-wide truncate">
            {checkoutCopy.order(c.order_ref)}
          </p>
          <h1 className="text-[22px] leading-8 font-bold">
            {c.merchant_name && c.merchant_name.trim() ? (
              checkoutCopy.title(c.merchant, c.merchant_name)
            ) : (
              <span>
                Pay{" "}
                {c.merchant.split(".").map((part, i, arr) => (
                  <span key={i}>
                    {part}
                    {i < arr.length - 1 ? (
                      <>
                        .<wbr />
                      </>
                    ) : null}
                  </span>
                ))}
              </span>
            )}
          </h1>
        </div>
        {chip ? <StatusChip status={chip} /> : null}
      </div>

      <div className="border-b border-border bg-surface-2/40 px-5 py-5 sm:px-6">
        <p className="caption">{partial ? p.stillDue : "Amount"}</p>
        <p className="tabular text-[40px] leading-[1.1] font-bold">
          {paid ? `$${c.amount_usd}` : `$${c.amount_usd}`}
        </p>
        {c.fee_mode === "pass_to_customer" && c.subtotal_usd && c.fee_usd ? (
          <p className="caption mt-1">
            {checkoutCopy.feeBreakdown(c.subtotal_usd, c.fee_usd, c.total_usd ?? c.amount_usd)}
          </p>
        ) : null}
        {partial ? (
          <p className="caption mt-1">
            {p.ofInvoice(`$${c.amount_usd}`, `$${formatToken(String(settled), 6)}`)}
          </p>
        ) : null}
        {/* The countdown stops and goes away as soon as the money has arrived (booked or not yet). */}
        {!paid &&
        (effectiveCheckout.status === "pending" || effectiveCheckout.status === "partial") ? (
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <span className="caption">{checkoutCopy.expiresIn}</span>
            <Countdown
              target={expiryMs}
              units={["minutes", "seconds"]}
              variant="compact"
              label={checkoutCopy.expiresIn}
              completeLabel={copy.countdown.expired}
            />
          </div>
        ) : null}
        {BigInt(c.surplus || "0") > 0n ? (
          <p className="caption mt-1">
            {checkoutCopy.overpaidNote(`$${formatToken(c.surplus, 6)}`)}
          </p>
        ) : null}
      </div>

      <dl className="grid gap-x-6 gap-y-4 px-5 py-4 text-[14px] sm:grid-cols-2 sm:px-6">
        <div className="min-w-0 space-y-1">
          <dt className="caption">{checkoutCopy.claimAccountLabel}</dt>
          <dd className="break-all">
            <AddressChip value={c.claim_account} />
          </dd>
        </div>
        <div className="min-w-0 space-y-1">
          <dt className="caption">Order reference</dt>
          <dd className="tabular font-medium break-all">{c.order_ref}</dd>
        </div>
      </dl>

      <div
        role="status"
        aria-live="polite"
        className="border-t border-border px-5 py-4 sm:px-6 space-y-2"
        data-checkout-status={banner.kind}
      >
        <p className="flex items-center gap-2 text-[16px] leading-6 font-semibold">
          {banner.kind === "paid" ? (
            <CheckCircle2 size={18} strokeWidth={1.5} className="text-success-text" aria-hidden />
          ) : banner.kind === "late" || banner.kind === "expired" ? (
            <AlertTriangle size={18} strokeWidth={1.5} className="text-warning-text" aria-hidden />
          ) : banner.kind === "settling" ? (
            <Clock size={18} strokeWidth={1.5} aria-hidden />
          ) : null}
          <span>{banner.title}</span>
        </p>
        <p className="text-[14px] leading-5 text-muted">{banner.body}</p>
        {paid && returnHref ? (
          <div className="pt-2">
            <a
              href={returnHref}
              className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-border bg-surface px-3 text-[13px] font-medium transition-colors hover:bg-surface-2"
            >
              <ArrowLeft size={14} strokeWidth={1.5} aria-hidden />
              {checkoutCopy.returnToMerchant}
            </a>
          </div>
        ) : !paid && (cancelHref ?? returnHref) ? (
          <div className="pt-2">
            <a
              href={(cancelHref ?? returnHref)!}
              className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-border bg-surface px-3 text-[13px] font-medium transition-colors hover:bg-surface-2"
            >
              <ArrowLeft size={14} strokeWidth={1.5} aria-hidden />
              {cancelHref ? checkoutCopy.backToShop : checkoutCopy.returnToMerchant}
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** An open checkout whose time has passed reads as expired at once, before the server says so. */
function effective(c: PublicCheckoutPayload, nowMs: number): PublicCheckout {
  return nowMs >= countdownTargetMs({ expires_at: c.expires_at }) && c.status === "pending"
    ? { ...c, status: "expired" }
    : c;
}

function summaryOf(c: PublicCheckoutPayload, topStage: PayStage | null, received = false) {
  const now = Date.now();
  const eff = effective(c, now);
  return (
    <CheckoutCard
      checkout={c}
      effectiveCheckout={eff}
      expiryMs={countdownTargetMs({ expires_at: c.expires_at })}
      banner={checkoutLiveBanner(eff, topStage)}
      received={received}
      returnHref={safeReturnUrl(c.return_url)}
      cancelHref={safeReturnUrl(c.cancel_url)}
    />
  );
}

/**
 * The hosted checkout page is the standard pay flow (the one invoices use: a pay card with Wallet, Exchange and Split,
 * the price and QR code in a pop-over, the steps across the page) with this summary card and a checkout's own words.
 */
/** The status each checkout page showed last (see `latchStatus`). */
const shownStatus = new Map<string, CheckoutStatus>();

const checkoutSource = (id: string): PayScreenSource => ({
  load: async (tokenId) => {
    try {
      const fresh = (await fetchCheckout(tokenId)) as unknown as PublicCheckoutPayload;
      // One status with confidence: it only moves forward while the page is open.
      const status = latchStatus(shownStatus.get(tokenId), fresh.status);
      shownStatus.set(tokenId, status);
      return (status === fresh.status ? fresh : { ...fresh, status }) as unknown as PayFlowClaim;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // An older invoice link: `/c/<id>` of an invoice goes to its own page.
        try {
          const res = await fetch(`${API_URL}/v1/pay/claims/${encodeURIComponent(id)}`, {
            headers: { accept: "application/json" },
          });
          if (res.ok) {
            const data = (await res.json()) as { token_id?: string };
            if (data.token_id === id) {
              window.location.replace(`/pay/${encodeURIComponent(id)}`);
            }
          }
        } catch {
          // fall through to not found
        }
      }
      throw e;
    }
  },
  listSessions: async (_tokenId, claim) =>
    (claim as unknown as PublicCheckoutPayload).sessions ?? [],
  isOpen: (claim) => {
    const c = claim as unknown as PublicCheckoutPayload;
    const now = Date.now();
    return canQuoteCheckout(effective(c, now), now);
  },
  isPaid: (claim) => {
    const status = (claim as unknown as PublicCheckoutPayload).status;
    return status === "paid" || status === "accepted";
  },
  summary: (claim, { topStage, received }) =>
    summaryOf(claim as unknown as PublicCheckoutPayload, topStage, received),
  closed: (claim) => {
    const c = claim as unknown as PublicCheckoutPayload;
    return (
      <>
        {summaryOf(c, null)}
        {c.history ? (
          <HistoryCard
            claim={
              {
                issued_at: c.history.issued_at,
                paid_at: c.history.paid_at ?? undefined,
                issue_tx: c.history.issue_tx ?? undefined,
                payments: c.history.payments,
              } as unknown as PayClaim
            }
          />
        ) : null}
      </>
    );
  },
  words: checkoutPayWords,
  sessionNote: (e) =>
    e instanceof ApiError &&
    (e.code === "checkout_expired" ||
      e.code === "quote_window_closed" ||
      e.code === "checkout_not_payable")
      ? checkoutCopy.expiredQuoteRefused
      : null,
  refreshMs: POLL_MS,
});

export function CheckoutScreen({ id }: { id: string }) {
  return <PayScreen tokenId={id} source={checkoutSourceFor(id)} />;
}

const sources = new Map<string, PayScreenSource>();
function checkoutSourceFor(id: string): PayScreenSource {
  let source = sources.get(id);
  if (source === undefined) {
    source = checkoutSource(id);
    sources.set(id, source);
  }
  return source;
}
