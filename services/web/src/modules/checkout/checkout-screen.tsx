"use client";

import { ApiError, type PaySession, type Route } from "@openrail/api-client";
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddressChip } from "@/components/ui/address-chip";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CHAINS } from "@/components/ui/chain-badge";
import { Countdown } from "@/components/ui/countdown";
import { Input } from "@/components/ui/input";
import { QrPanel } from "@/components/ui/qr-panel";
import { EmptyState, ErrorState } from "@/components/ui/state";
import { ErrorNote } from "@/components/ui/error-note";
import { Tabs } from "@/components/ui/tabs";
import { Timeline } from "@/components/ui/timeline";
import { EvmWalletView } from "@/components/wallet-buttons";
import { RouteSelects } from "@/components/pay/route-selects";
import { StatusChip, type Status } from "@/components/ui/status-chip";
import { copy } from "@/copy";
import { client } from "@/lib/client";
import { formatUsd } from "@/lib/format";
import {
  amountPrefix,
  centsToApi,
  chainOfRoute,
  formatToken,
  hashStrings,
  legAmountProblem,
  legCents,
  payStage,
  payTimeline,
  payUnits,
  refundAddressProblem,
  remainingCents,
  spreadLabel,
  type PayStage,
  type PayStatus,
} from "@/lib/pay";
import { useEvm } from "@/wallet/evm";
import {
  canQuoteCheckout,
  checkoutCopy,
  checkoutLiveBanner,
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
}

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "notfound" }
  | { state: "ready"; checkout: PublicCheckoutPayload };

type Mode = "wallet" | "paste";

interface Leg {
  session: PaySession;
  route: Route;
  cents: bigint;
  stage: PayStage;
}

function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const amountOf = (session: PaySession, route: Route): string =>
  formatToken(
    payUnits(session.amount_in, route.origin_decimals, route.payer_asset),
    route.origin_decimals,
  );

const timeOf = (ms: number): string => {
  const at = new Date(ms);
  const time = at.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${time} UTC`;
};

async function fetchCheckout(id: string): Promise<PublicCheckoutPayload> {
  const response = await fetch(`${API_URL}/v1/public/checkouts/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) throw new ApiError(404, { error: { code: "checkout_not_found" } });
  if (!response.ok) throw new ApiError(response.status, { error: { code: "load_failed" } });
  return (await response.json()) as PublicCheckoutPayload;
}

function QuoteNote({
  session,
  route,
  partLabel,
}: {
  session: PaySession;
  route: Route;
  partLabel?: string;
}) {
  const p = copy.pay;
  const chain = chainOfRoute(route);
  const chainName = chain ? CHAINS[chain] : route.origin_chain;
  const upto = amountPrefix(route) === "upto";
  const deadlineMs = countdownTargetMs(session);
  return (
    <section
      aria-label={partLabel ? `${p.quoteTitle}, ${partLabel}` : p.quoteTitle}
      className="surface-card space-y-4 p-6"
    >
      <h2 className="text-[18px] leading-[26px] font-semibold">
        {partLabel ? `${p.quoteTitle} · ${partLabel}` : p.quoteTitle}
      </h2>
      <dl className="space-y-3">
        <div>
          <dt className="caption">{upto ? p.youSendUpTo : p.youSendExact}</dt>
          <dd className="tabular text-[28px] leading-[1.1] font-bold">
            {amountOf(session, route)} {route.payer_asset}{" "}
            <span className="text-[15px] font-normal text-muted">{p.on(chainName)}</span>
          </dd>
        </div>
        <div>
          <dt className="caption">{p.invoiceGets}</dt>
          <dd className="tabular text-[18px] font-semibold">
            ${formatToken(session.amount_out, 6)}
          </dd>
        </div>
        {upto ? (
          <div>
            <dt className="caption">{p.margin}</dt>
            <dd className="tabular text-[15px] font-medium">{spreadLabel(session.spread_bps)}</dd>
          </div>
        ) : null}
      </dl>
      {upto ? <p className="caption">{p.marginNote}</p> : null}
      <p className="text-[14px] leading-5">{p.locked(timeOf(deadlineMs))}</p>
    </section>
  );
}

function WalletPay({ session, route }: { session: PaySession; route: Route }) {
  const p = copy.pay;
  const evm = useEvm();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (route.evm_chain_id === null || !evm.available) return null;

  const send = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const hash = await evm.pay({
        chainId: route.evm_chain_id as number,
        to: session.deposit_address as `0x${string}`,
        amount: BigInt(payUnits(session.amount_in, route.origin_decimals, route.payer_asset)),
        token: route.origin_contract === null ? null : (route.origin_contract as `0x${string}`),
      });
      setSent(hash);
    } catch (e) {
      const code = (e as { code?: number } | null)?.code;
      setProblem(code === 4001 ? p.walletRejected : p.walletFailed);
    } finally {
      setBusy(false);
    }
  };

  const amount = `${amountOf(session, route)} ${route.payer_asset}`;
  return (
    <div className="surface-card space-y-3 p-4 sm:p-6">
      {evm.address ? (
        <Button type="button" onClick={() => void send()} loading={busy} disabled={sent !== null}>
          {p.walletPay(amount)}
        </Button>
      ) : (
        <Button type="button" variant="secondary" onClick={() => void evm.connect()}>
          {p.walletConnect}
        </Button>
      )}
      {sent ? (
        <p className="caption break-all" role="status">
          {p.walletSent} {sent}
        </p>
      ) : null}
      <ErrorNote>{problem ? problem : null}</ErrorNote>
    </div>
  );
}

function SessionView({
  session,
  route,
  canRefresh,
  onNewQuote,
  starting,
  partLabel,
  onStage,
}: {
  session: PaySession;
  route: Route;
  canRefresh: boolean;
  onNewQuote: () => void;
  starting: boolean;
  partLabel?: string;
  onStage?: (stage: PayStage) => void;
}) {
  const p = copy.pay;
  const now = useNow();
  const [status, setStatus] = useState<PayStatus>(session.status);
  const [hashes, setHashes] = useState<{ origin: string[]; near: string[] }>({
    origin: [],
    near: [],
  });
  const [pollFailed, setPollFailed] = useState(false);
  const [short, setShort] = useState(false);
  const chain = chainOfRoute(route);
  const deadlineMs = countdownTargetMs(session);
  const deadlineIso = new Date(deadlineMs).toISOString();

  const stage = payStage(status, deadlineIso, now ?? 0);
  const live = now !== null && (stage === "waiting" || stage === "processing");

  useEffect(() => {
    if (now !== null) onStage?.(stage);
  }, [stage, now, onStage]);

  useEffect(() => {
    if (!live) return;
    let off = false;
    const tick = async () => {
      try {
        const r = await client.pay.getSession(session.id);
        if (off) return;
        setStatus(r.status);
        setShort(r.swap_details.status === "INCOMPLETE_DEPOSIT");
        setHashes({
          origin: hashStrings(r.swap_details.origin_chain_tx_hashes),
          near: hashStrings(r.swap_details.near_tx_hashes),
        });
        setPollFailed(false);
      } catch {
        if (!off) setPollFailed(true);
      }
    };
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      off = true;
      clearInterval(id);
    };
  }, [live, session.id]);

  if (stage === "expired")
    return (
      <div className="surface-card space-y-4 p-6" role="status">
        <h2 className="text-[18px] leading-[26px] font-semibold">{p.expiredTitle}</h2>
        <p className="text-[15px]">{canRefresh ? p.expiredBody : checkoutCopy.expiredBody}</p>
        {canRefresh ? (
          <Button onClick={onNewQuote} loading={starting}>
            {p.newQuote}
          </Button>
        ) : null}
      </div>
    );

  if (stage === "paid")
    return (
      <div className="space-y-4">
        <div className="surface-card space-y-3 p-6" role="status">
          <p className="flex items-center gap-2 text-[20px] font-semibold">
            <CheckCircle2 size={22} strokeWidth={1.5} className="text-success-text" aria-hidden />
            {p.paidTitle}
          </p>
          <p className="text-[15px]">{p.paidBody(usdcToUsd(session.amount_out))}</p>
        </div>
        {hashes.origin.length > 0 || hashes.near.length > 0 ? (
          <Card title={p.proofTitle}>
            <ul className="space-y-2">
              {hashes.origin.map((h) => (
                <li key={h}>
                  <p className="caption">{p.originTx}</p>
                  <AddressChip value={h} chain={chain ?? undefined} />
                </li>
              ))}
              {hashes.near.map((h) => (
                <li key={h}>
                  <p className="caption">{p.payoutTx}</p>
                  <AddressChip value={h} chain="near" />
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    );

  const steps = payTimeline(stage).map((s) => ({
    id: s.id,
    title: s.id === "received" ? checkoutCopy.settlingTitle : p.steps[s.id],
    status: s.status,
  }));

  return (
    <div className="space-y-4">
      <QuoteNote session={session} route={route} partLabel={partLabel} />

      {stage === "refunded" || stage === "failed" ? (
        <div role="alert" className="surface-card space-y-2 p-6">
          <h2 className="text-[18px] leading-[26px] font-semibold">
            {stage === "refunded" ? p.refundedTitle : p.failedTitle}
          </h2>
          <p className="text-[15px]">{stage === "refunded" ? p.refundedBody : p.failedBody}</p>
          {canRefresh ? (
            <Button onClick={onNewQuote} loading={starting}>
              {p.newQuote}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <QrPanel
            address={session.deposit_address}
            amount={`${amountOf(session, route)} ${route.payer_asset}`}
            chain={chain ?? undefined}
          />
          <WalletPay session={session} route={route} />
          <p className="caption px-1">
            {p.sendOnly(route.payer_asset, chain ? CHAINS[chain] : route.origin_chain)}
          </p>
          <p className="caption px-1">
            {short
              ? p.shortSeen(amountOf(session, route), route.payer_asset)
              : p.shortRule(amountOf(session, route), route.payer_asset)}
          </p>
          <div className="flex items-center justify-between px-1">
            <span className="caption">{p.timeLeft}</span>
            <Countdown
              target={deadlineMs}
              units={["minutes", "seconds"]}
              variant="compact"
              label={p.timeLeft}
              completeLabel={copy.countdown.expired}
            />
          </div>
        </>
      )}

      <Card title={p.progress}>
        <Timeline steps={steps} />
        <p role="status" className="caption mt-4">
          {stage === "waiting"
            ? p.stepNote.waiting
            : stage === "processing"
              ? checkoutCopy.settlingBody
              : ""}
        </p>
        <ErrorNote>{pollFailed ? p.pollError : null}</ErrorNote>
      </Card>
    </div>
  );
}

function usdcToUsd(units: string): string {
  return `$${formatToken(units, 6)}`;
}

/** An invoice-style card on top of the checkout: merchant, order reference, amount, expiry countdown, and live status. */
function CheckoutCard({
  checkout: c,
  effectiveCheckout,
  expiryMs,
  banner,
  returnHref,
}: {
  checkout: PublicCheckoutPayload;
  effectiveCheckout: PublicCheckout;
  expiryMs: number;
  banner: LiveBanner;
  returnHref: string | null;
}) {
  const p = copy.pay;
  const paid = effectiveCheckout.status === "paid" || effectiveCheckout.status === "accepted";
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
        <div>
          <p className="caption uppercase tracking-wide">{checkoutCopy.order(c.order_ref)}</p>
          <h1 className="text-[22px] leading-8 font-bold">{checkoutCopy.title(c.merchant)}</h1>
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
        {effectiveCheckout.status === "pending" || effectiveCheckout.status === "partial" ? (
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
        <div className="space-y-1">
          <dt className="caption">{p.claimAccountLabel}</dt>
          <dd>
            <AddressChip value={c.claim_account} />
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="caption">Order reference</dt>
          <dd className="tabular font-medium">{c.order_ref}</dd>
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
        {returnHref ? (
          <div className="pt-2">
            <a
              href={returnHref}
              className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-border bg-surface px-3 text-[13px] font-medium transition-colors hover:bg-surface-2"
            >
              <ArrowLeft size={14} strokeWidth={1.5} aria-hidden />
              {checkoutCopy.returnToMerchant}
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function CheckoutScreen({ id }: { id: string }) {
  const p = copy.pay;
  const evm = useEvm();
  const now = useNow();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const [mode, setMode] = useState<Mode>("wallet");
  const [routeId, setRouteId] = useState<string | null>(null);
  const [legs, setLegs] = useState<Leg[]>([]);
  const [starting, setStarting] = useState(false);
  const [sessionError, setSessionError] = useState<null | "failed" | "refund" | "expired">(null);
  const [refund, setRefund] = useState("");
  const [refundShown, setRefundShown] = useState(false);
  const [split, setSplit] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [amountShown, setAmountShown] = useState(false);
  const restored = useRef(false);

  useEffect(() => {
    let off = false;
    setLoad({ state: "loading" });
    fetchCheckout(id)
      .then((checkout) => !off && setLoad({ state: "ready", checkout }))
      .catch(async (e: unknown) => {
        if (off) return;
        if (e instanceof ApiError && e.status === 404) {
          try {
            const res = await fetch(`${API_URL}/v1/pay/claims/${encodeURIComponent(id)}`, {
              headers: { accept: "application/json" },
            });
            if (res.ok) {
              const data = (await res.json()) as { token_id?: string };
              if (data.token_id === id) {
                window.location.replace(`/pay/${encodeURIComponent(id)}`);
                return;
              }
            }
          } catch {
            // ignore
          }
          setLoad({ state: "notfound" });
          return;
        }
        setLoad({ state: "error" });
      });
    return () => {
      off = true;
    };
  }, [id, tick]);

  const checkout = load.state === "ready" ? load.checkout : null;
  const routes = useMemo(
    () => (checkout?.routes ?? []).filter((r) => chainOfRoute(r) !== null),
    [checkout],
  );

  // Refresh the checkout status while it is open or settling so partial, paid and late transitions appear live.
  useEffect(() => {
    if (!checkout) return;
    if (checkout.status === "paid" || checkout.status === "accepted") {
      return;
    }
    let off = false;
    const poll = async () => {
      try {
        const fresh = await fetchCheckout(id);
        if (!off) setLoad({ state: "ready", checkout: fresh });
      } catch {
        /* keep current view */
      }
    };
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      off = true;
      clearInterval(timer);
    };
  }, [id, checkout?.status]);

  useEffect(() => {
    if (restored.current || !checkout || routes.length === 0) return;
    restored.current = true;
    const data = checkout.sessions ?? [];
    const currentMs = Date.now();
    const back: Leg[] = [];
    for (const sess of data) {
      const r = routes.find((x) => x.id === sess.route_id);
      const cents = legCents(sess.amount_usd);
      const open = countdownTargetMs(sess) > currentMs || sess.status === "success";
      const owed = BigInt(checkout.outstanding ?? "0");
      const current = cents !== null && (owed === 0n || cents * 10_000n <= owed);
      if (r && cents !== null && open && current) {
        back.push({ session: sess, route: r, cents, stage: "waiting" });
      }
    }
    const keep = back.slice(-1);
    if (keep.length > 0) {
      setLegs(keep);
      setRouteId(keep[keep.length - 1]?.route.id ?? null);
    }
  }, [checkout, routes]);

  const route = routes.find((r) => r.id === routeId) ?? null;
  const outstanding = checkout?.outstanding ?? "0";
  const remaining = remainingCents(outstanding, legs);
  const refundProblem = refundAddressProblem(route ? chainOfRoute(route) : null, refund);
  const amountProblem = split ? legAmountProblem(amountText, remaining) : null;

  useEffect(() => {
    if (mode === "wallet" && route && route.evm_chain_id !== null && evm.address && refund === "")
      setRefund(evm.address);
  }, [mode, route, evm.address, refund]);

  const pickRoute = (nextId: string) => {
    setRouteId(nextId);
    setSessionError(null);
    setRefundShown(false);
    if (!split) setLegs([]);
  };

  const turnSplitOn = () => {
    if (!split) setLegs([]);
    setSplit(true);
    setAmountText(centsToApi(remaining));
    setAmountShown(false);
  };

  const setStage = useCallback((sessionId: string, stage: PayStage) => {
    setLegs((l) =>
      l.some((x) => x.session.id === sessionId && x.stage !== stage)
        ? l.map((x) => (x.session.id === sessionId ? { ...x, stage } : x))
        : l,
    );
  }, []);

  const start = useCallback(
    async (r: Route, refundTo: string, cents: bigint, partial: boolean, replace?: string) => {
      if (!checkout || !canQuoteCheckout(checkout, Date.now())) {
        setSessionError("expired");
        return;
      }
      setSessionError(null);
      setStarting(true);
      try {
        const s = await client.pay.createSession({
          token_id: checkout.token_id,
          route_id: r.id,
          refund_to: refundTo.trim(),
          ...(partial ? { amount_usd: centsToApi(cents) } : {}),
        });
        const leg: Leg = { session: s, route: r, cents, stage: "waiting" };
        setLegs((l) =>
          replace
            ? l.map((x) => (x.session.id === replace ? leg : x))
            : partial
              ? [...l, leg]
              : [leg],
        );
        if (partial && !replace) {
          setAmountText("");
          setAmountShown(false);
        }
      } catch (e) {
        if (
          e instanceof ApiError &&
          (e.code === "checkout_expired" ||
            e.code === "quote_window_closed" ||
            e.code === "checkout_not_payable")
        ) {
          setSessionError("expired");
        } else if (e instanceof ApiError && e.code === "invalid_refund_address") {
          setSessionError("refund");
        } else {
          setSessionError("failed");
        }
      } finally {
        setStarting(false);
      }
    },
    [checkout],
  );

  if (load.state === "loading") return <Card state="loading" />;
  if (load.state === "error")
    return (
      <div className="surface-card">
        <ErrorState body={checkoutCopy.loadError} onRetry={() => setTick((t) => t + 1)} />
      </div>
    );
  if (load.state === "notfound")
    return (
      <div className="surface-card">
        <EmptyState title={checkoutCopy.notFoundTitle} body={checkoutCopy.notFoundBody} />
      </div>
    );

  const c = load.checkout;
  const expiryMs = countdownTargetMs({ expires_at: c.expires_at });
  const timePassed = now !== null && now >= expiryMs;
  const effectiveCheckout: PublicCheckout =
    timePassed && c.status === "pending" ? { ...c, status: "expired" } : c;
  const quotable = canQuoteCheckout(
    effectiveCheckout,
    now ?? Date.parse(c.server_time ?? c.expires_at) - 1000,
  );
  const topStage: PayStage | null =
    legs.find((l) => l.stage === "paid")?.stage ??
    legs.find((l) => l.stage === "processing")?.stage ??
    legs[legs.length - 1]?.stage ??
    null;
  const banner = checkoutLiveBanner(effectiveCheckout, topStage);
  const returnHref = safeReturnUrl(c.return_url);
  const covered = split && legs.length > 0 && remaining === 0n;

  const submit = () => {
    setRefundShown(true);
    setAmountShown(true);
    if (!route || refundProblem !== null || amountProblem !== null) return;
    const cents = split ? (legCents(amountText) ?? 0n) : remainingCents(outstanding, []);
    void start(route, refund, cents, split);
  };

  const form = (tab: Mode) => (
    <div className="space-y-4">
      {tab === "paste" ? (
        <>
          <p role="note" className="rounded-[10px] bg-surface-2 p-3 text-[14px] leading-5">
            {p.exchangeWarn}
          </p>
          <p className="caption">{p.refundRule}</p>
        </>
      ) : (
        <div className="space-y-2">
          <p className="caption">{p.walletTabHelp}</p>
          <EvmWalletView {...evm} />
        </div>
      )}
      <RouteSelects routes={routes} routeId={routeId} onPick={pickRoute} />
      {!split ? (
        <Button type="button" variant="secondary" onClick={turnSplitOn}>
          {p.mixSplit}
        </Button>
      ) : null}
      {route && !covered ? (
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            label={p.refundLabel}
            helper={p.refundHelp}
            value={refund}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setRefund(e.target.value.trim())}
            error={
              (refundShown && refundProblem) ||
              (sessionError === "refund" ? p.refundRejected : undefined) ||
              undefined
            }
          />
          {split ? (
            <Input
              label={p.mixAmount}
              helper={p.mixAmountHelp(formatUsd(remaining))}
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              error={(amountShown && amountProblem) || undefined}
            />
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" loading={starting}>
              {split ? p.mixGetPrice : p.getPrice}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-[640px] space-y-6">
      <CheckoutCard
        checkout={c}
        effectiveCheckout={effectiveCheckout}
        expiryMs={expiryMs}
        banner={banner}
        returnHref={returnHref}
      />

      <div className="min-w-0 space-y-6">
        {!quotable ? null : routes.length === 0 ? (
          <div className="surface-card">
            <EmptyState title={p.noRoutes} />
          </div>
        ) : (
          <Card title={p.pickTitle}>
            <p className="caption mb-4">{p.pickHelp}</p>
            <Tabs
              fill
              label={p.tabsLabel}
              value={mode}
              onValueChange={(next) => setMode(next as Mode)}
              items={[
                { id: "wallet", label: p.tabWallet, panel: form("wallet") },
                { id: "paste", label: p.tabPaste, panel: form("paste") },
              ]}
            />
            {split || legs.length === 0 ? <p className="caption mt-4">{p.mixSplitHelp}</p> : null}
          </Card>
        )}

        {legs.map((l, i) => (
          <SessionView
            key={l.session.id}
            session={l.session}
            route={l.route}
            canRefresh={quotable}
            partLabel={split ? p.mixPart(i + 1) : undefined}
            onStage={(stage) => setStage(l.session.id, stage)}
            onNewQuote={() => void start(l.route, refund, l.cents, split, l.session.id)}
            starting={starting}
          />
        ))}

        {quotable && starting ? <Card title={p.getting} state="loading" /> : null}

        {sessionError === "expired" ? (
          <div role="alert" className="surface-card p-6 text-[15px]">
            {checkoutCopy.expiredQuoteRefused}
          </div>
        ) : null}

        {quotable && sessionError === "failed" ? (
          <div className="surface-card">
            <ErrorState
              body={split && legs.length > 0 ? p.mixPartFailed : p.sessionError}
              onRetry={route ? submit : undefined}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
