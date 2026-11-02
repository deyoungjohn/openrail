"use client";

import { ApiError, type PaySession, type PublicClaim, type Route } from "@openrail/api-client";
import { CheckCircle2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { copy } from "@/copy";
import { client } from "@/lib/client";
import {
  amountPrefix,
  chainOfRoute,
  formatDueDate,
  formatToken,
  payStage,
  payTimeline,
  refundAddressProblem,
  spreadLabel,
  type PayStatus,
} from "@/lib/pay";
import { useEvm } from "@/wallet/evm";
import { AddressChip } from "../ui/address-chip";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { CHAINS, ChainBadge } from "../ui/chain-badge";
import { Countdown } from "../ui/countdown";
import { Input } from "../ui/input";
import { QrPanel } from "../ui/qr-panel";
import { EmptyState, ErrorState } from "../ui/state";
import { Timeline } from "../ui/timeline";

type Session = PaySession;

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "notfound" }
  | { state: "ready"; claim: PublicClaim };

const POLL_MS = 3000;

function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";

function usdcToUsd(units: string): string {
  return `$${formatToken(units, 6)}`;
}

function QuoteNote({ session, route }: { session: Session; route: Route }) {
  const p = copy.pay;
  const chain = chainOfRoute(route);
  const chainName = chain ? CHAINS[chain] : route.origin_chain;
  const upto = amountPrefix(route) === "upto";
  return (
    <section aria-label={p.quoteTitle} className="surface-card space-y-4 p-6">
      <h2 className="text-[18px] leading-[26px] font-semibold">{p.quoteTitle}</h2>
      <dl className="space-y-3">
        <div>
          <dt className="caption">{upto ? p.youSendUpTo : p.youSendExact}</dt>
          <dd className="tabular text-[28px] leading-[1.1] font-bold">
            {formatToken(session.amount_in, route.origin_decimals)} {route.payer_asset}{" "}
            <span className="text-[15px] font-normal text-muted">{p.on(chainName)}</span>
          </dd>
        </div>
        <div>
          <dt className="caption">{p.invoiceGets}</dt>
          <dd className="tabular text-[18px] font-semibold">{usdcToUsd(session.amount_out)}</dd>
        </div>
        {upto ? (
          <div>
            <dt className="caption">{p.margin}</dt>
            <dd className="tabular text-[15px] font-medium">{spreadLabel(session.spread_bps)}</dd>
          </div>
        ) : null}
      </dl>
      {upto ? <p className="caption">{p.marginNote}</p> : null}
      <p className="text-[14px] leading-5">{p.locked(timeOf(session.deadline))}</p>
    </section>
  );
}

function SessionView({
  session,
  route,
  onNewQuote,
  starting,
}: {
  session: Session;
  route: Route;
  onNewQuote: () => void;
  starting: boolean;
}) {
  const p = copy.pay;
  const now = useNow();
  const [status, setStatus] = useState<PayStatus>(session.status);
  const [hashes, setHashes] = useState<{ origin: string[]; near: string[] }>({
    origin: [],
    near: [],
  });
  const [pollFailed, setPollFailed] = useState(false);
  const chain = chainOfRoute(route);

  const stage = payStage(status, session.deadline, now ?? 0);
  const live = now !== null && (stage === "waiting" || stage === "processing");

  useEffect(() => {
    if (!live) return;
    let off = false;
    const tick = async () => {
      try {
        const r = await client.pay.getSession(session.id);
        if (off) return;
        setStatus(r.status);
        setHashes({
          origin: r.swap_details.origin_chain_tx_hashes ?? [],
          near: r.swap_details.near_tx_hashes ?? [],
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
        <p className="text-[15px]">{p.expiredBody}</p>
        <Button onClick={onNewQuote} loading={starting}>
          {p.newQuote}
        </Button>
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
          <p className="text-[15px]">{p.paidBody(session.amount_usd)}</p>
        </div>
        {hashes.origin.length + hashes.near.length > 0 ? (
          <Card title={p.proofTitle}>
            <ul className="space-y-3">
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
    title: p.steps[s.id],
    status: s.status,
  }));

  return (
    <div className="space-y-4">
      {/* The locked amount comes before the address (quote_note_before_address_shown). */}
      <QuoteNote session={session} route={route} />

      {stage === "refunded" || stage === "failed" ? (
        <div role="alert" className="surface-card space-y-2 p-6">
          <h2 className="text-[18px] leading-[26px] font-semibold">
            {stage === "refunded" ? p.refundedTitle : p.failedTitle}
          </h2>
          <p className="text-[15px]">{stage === "refunded" ? p.refundedBody : p.failedBody}</p>
          <Button onClick={onNewQuote} loading={starting}>
            {p.newQuote}
          </Button>
        </div>
      ) : (
        <>
          <QrPanel
            address={session.deposit_address}
            amount={`${formatToken(session.amount_in, route.origin_decimals)} ${route.payer_asset}`}
            chain={chain ?? undefined}
          />
          <p className="caption px-1">
            {p.sendOnly(route.payer_asset, chain ? CHAINS[chain] : route.origin_chain)}
          </p>
          <div className="flex items-center justify-between px-1">
            <span className="caption">{p.timeLeft}</span>
            <Countdown expiresAt={Date.parse(session.deadline)} />
          </div>
        </>
      )}

      <Card title={p.progress}>
        <Timeline steps={steps} />
        <p role="status" className="caption mt-4">
          {stage === "waiting"
            ? p.stepNote.waiting
            : stage === "processing"
              ? p.stepNote.processing
              : ""}
        </p>
        {pollFailed ? <p className="text-danger-text mt-2 text-[14px]">{p.pollError}</p> : null}
      </Card>
    </div>
  );
}

export function PayScreen({ tokenId }: { tokenId: string }) {
  const p = copy.pay;
  const evm = useEvm();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [starting, setStarting] = useState(false);
  const [sessionError, setSessionError] = useState<null | "failed" | "refund">(null);
  const [refund, setRefund] = useState("");
  const [refundShown, setRefundShown] = useState(false);

  useEffect(() => {
    let off = false;
    setLoad({ state: "loading" });
    client.pay
      .getClaim(tokenId)
      .then((claim) => !off && setLoad({ state: "ready", claim }))
      .catch((e: unknown) => {
        if (off) return;
        setLoad(
          e instanceof ApiError && e.status === 404 ? { state: "notfound" } : { state: "error" },
        );
      });
    return () => {
      off = true;
    };
  }, [tokenId, tick]);

  const claim = load.state === "ready" ? load.claim : null;
  const routes = useMemo(
    () => (claim?.routes ?? []).filter((r) => chainOfRoute(r) !== null),
    [claim],
  );
  const route = routes.find((r) => r.id === routeId) ?? null;

  const refundProblem = refundAddressProblem(route ? chainOfRoute(route) : null, refund);

  // Prefill the refund address from a connected wallet, once, for routes on an EVM chain.
  useEffect(() => {
    if (route && route.evm_chain_id !== null && evm.address && refund === "")
      setRefund(evm.address);
  }, [route, evm.address, refund]);

  const pickRoute = (id: string) => {
    setRouteId(id);
    setSession(null);
    setSessionError(null);
    setRefundShown(false);
  };

  const start = useCallback(
    async (id: string, refundTo: string) => {
      setSession(null);
      setSessionError(null);
      setStarting(true);
      try {
        const s = await client.pay.createSession({
          token_id: tokenId,
          route_id: id,
          refund_to: refundTo.trim(),
        });
        setSession(s);
      } catch (e) {
        setSessionError(
          e instanceof ApiError && e.code === "invalid_refund_address" ? "refund" : "failed",
        );
      } finally {
        setStarting(false);
      }
    },
    [tokenId],
  );

  if (load.state === "loading") return <Card state="loading" />;
  if (load.state === "error")
    return (
      <div className="surface-card">
        <ErrorState body={p.loadError} onRetry={() => setTick((t) => t + 1)} />
      </div>
    );
  if (load.state === "notfound")
    return (
      <div className="surface-card">
        <EmptyState title={p.notFoundTitle} body={p.notFoundBody} />
      </div>
    );

  const c = load.claim;
  const open = c.status === "Issued" || c.status === "PartiallyPaid";
  const usdc = routes.filter((r) => r.payer_asset === "USDC");
  const volatile = routes.filter((r) => r.payer_asset !== "USDC");

  const picker = (title: string, list: Route[]) =>
    list.length === 0 ? null : (
      <div>
        <h3 className="mb-2 text-[14px] leading-5 font-medium text-muted">{title}</h3>
        <div className="flex flex-wrap gap-2">
          {list.map((r) => {
            const chain = chainOfRoute(r);
            return chain ? (
              <ChainBadge
                key={r.id}
                chain={chain}
                label={p.routeLabel(r.payer_asset, CHAINS[chain])}
                selected={routeId === r.id}
                onSelect={() => pickRoute(r.id)}
              />
            ) : null;
          })}
        </div>
      </div>
    );

  const session_ =
    open && routeId ? (
      starting ? (
        <Card title={p.getting} state="loading" />
      ) : sessionError === "failed" ? (
        <div className="surface-card">
          <ErrorState body={p.sessionError} onRetry={() => void start(routeId, refund)} />
        </div>
      ) : session && route ? (
        <SessionView
          key={session.id}
          session={session}
          route={route}
          onNewQuote={() => void start(route.id, refund)}
          starting={starting}
        />
      ) : null
    ) : null;

  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start lg:gap-8">
      <div className="space-y-6">
        <header className="space-y-1">
          <p className="caption">{p.invoice(c.invoice_number)}</p>
          <h1 className="text-[28px] leading-9 font-bold">{p.title(c.issuer_legal_name)}</h1>
          <p className="tabular text-[36px] leading-[1.1] font-bold">${c.amount_usd}</p>
          <p className="caption">{p.due(formatDueDate(c.due_date))}</p>
          {c.status === "PartiallyPaid" ? (
            <p className="text-[14px] font-medium">
              {p.partial(`$${formatToken(c.outstanding, 6)}`)}
            </p>
          ) : null}
        </header>

        {!open ? (
          <div role="status" className="surface-card p-6 text-[15px]">
            {c.status === "Paid" ? p.alreadyPaid : p.closed}
          </div>
        ) : routes.length === 0 ? (
          <div className="surface-card">
            <EmptyState title={p.noRoutes} />
          </div>
        ) : (
          <Card title={p.pickTitle}>
            <p className="caption mb-4">{p.pickHelp}</p>
            <div className="space-y-4">
              {picker(p.pickUsdc, usdc)}
              {picker(p.pickVolatile, volatile)}
            </div>
            {route ? (
              <form
                noValidate
                className="mt-6 space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  setRefundShown(true);
                  if (refundProblem === null) void start(route.id, refund);
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
                <Button type="submit" loading={starting}>
                  {p.getPrice}
                </Button>
              </form>
            ) : null}
          </Card>
        )}
      </div>
      <div className="space-y-6">{session_}</div>
    </div>
  );
}
