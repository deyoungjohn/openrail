"use client";

import { ApiError, type PaySession, type PublicClaim, type Route } from "@openrail/api-client";
import { CheckCircle2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copy } from "@/copy";
import { client } from "@/lib/client";
import {
  amountPrefix,
  centsToApi,
  chainOfRoute,
  formatDueDate,
  formatToken,
  legAmountProblem,
  legCents,
  payStage,
  payTimeline,
  refundAddressProblem,
  remainingCents,
  spreadLabel,
  type PayStage,
  type PayStatus,
} from "@/lib/pay";
import { formatUsd } from "@/lib/format";
import { useEvm } from "@/wallet/evm";
import { AddressChip } from "../ui/address-chip";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { CHAINS, ChainBadge } from "../ui/chain-badge";
import { Countdown } from "../ui/countdown";
import { Input } from "../ui/input";
import { Tabs } from "../ui/tabs";
import { EvmWalletView } from "../wallet-buttons";
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

const timeOf = (iso: string) => {
  const at = new Date(iso);
  const time = at.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  // Beyond a day the time of day alone is ambiguous: add the date.
  const far = at.getTime() - Date.now() > 20 * 3600 * 1000;
  const day = far
    ? at.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) + ", "
    : "";
  return `${day}${time} UTC`;
};

function usdcToUsd(units: string): string {
  return `$${formatToken(units, 6)}`;
}

function QuoteNote({
  session,
  route,
  partLabel,
}: {
  session: Session;
  route: Route;
  partLabel?: string;
}) {
  const p = copy.pay;
  const chain = chainOfRoute(route);
  const chainName = chain ? CHAINS[chain] : route.origin_chain;
  const upto = amountPrefix(route) === "upto";
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
  partLabel,
  onStage,
}: {
  session: Session;
  route: Route;
  onNewQuote: () => void;
  starting: boolean;
  /** `Part 2` when the payment is split. */
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

  const stage = payStage(status, session.deadline, now ?? 0);
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
      <QuoteNote session={session} route={route} partLabel={partLabel} />

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
          <p className="caption px-1">
            {short
              ? p.shortSeen(
                  formatToken(session.amount_in, route.origin_decimals),
                  route.payer_asset,
                )
              : p.shortRule(
                  formatToken(session.amount_in, route.origin_decimals),
                  route.payer_asset,
                )}
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

interface Leg {
  session: Session;
  route: Route;
  cents: bigint;
  stage: PayStage;
}

type Mode = "paste" | "wallet";

export function PayScreen({ tokenId }: { tokenId: string }) {
  const p = copy.pay;
  const evm = useEvm();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const [mode, setMode] = useState<Mode>("paste");
  const [routeId, setRouteId] = useState<string | null>(null);
  const [legs, setLegs] = useState<Leg[]>([]);
  const [starting, setStarting] = useState(false);
  const [sessionError, setSessionError] = useState<null | "failed" | "refund">(null);
  const [refund, setRefund] = useState("");
  const [refundShown, setRefundShown] = useState(false);
  const [split, setSplit] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [amountShown, setAmountShown] = useState(false);
  const [earlier, setEarlier] = useState<{ address: string; route: string }[]>([]);
  const restored = useRef(false);

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

  // A reload must not lose a price the payer may already have sent money to: the server keeps every
  // price it gave for this invoice. Open ones come back as they were; the rest are listed as earlier.
  useEffect(() => {
    if (restored.current || routes.length === 0) return;
    restored.current = true;
    client.pay
      .listSessions(tokenId)
      .then(({ data }) => {
        const now = Date.now();
        const back: Leg[] = [];
        for (const sess of data) {
          const r = routes.find((x) => x.id === sess.route_id);
          const cents = legCents(sess.amount_usd);
          const open = Date.parse(sess.deadline) > now || sess.status === "success";
          if (r && cents !== null && open) {
            back.push({ session: sess, route: r, cents, stage: "waiting" });
          }
        }
        // The newest open price comes back on screen.
        const keep = back.slice(-1);
        setEarlier(
          data.map((x) => ({
            address: x.deposit_address,
            route: routes.find((r) => r.id === x.route_id)?.payer_asset ?? x.route_id,
          })),
        );
        if (keep.length > 0) {
          setLegs(keep);
          setRouteId(keep[keep.length - 1]?.route.id ?? null);
          setSplit(keep.length > 1);
        }
      })
      .catch(() => undefined);
  }, [routes, tokenId]);

  // A price made on this page joins the list of addresses once it is replaced.
  useEffect(() => {
    setEarlier((old) => {
      const seen = new Set(old.map((e) => e.address));
      const added = legs
        .filter((l) => !seen.has(l.session.deposit_address))
        .map((l) => ({ address: l.session.deposit_address, route: l.route.payer_asset }));
      return added.length > 0 ? [...old, ...added] : old;
    });
  }, [legs]);

  const route = routes.find((r) => r.id === routeId) ?? null;
  const outstanding = claim?.outstanding ?? "0";
  // What is left to pay once the parts so far are counted.
  const remaining = remainingCents(outstanding, legs);

  const refundProblem = refundAddressProblem(route ? chainOfRoute(route) : null, refund);
  const amountProblem = split ? legAmountProblem(amountText, remaining) : null;

  // A connected wallet fills in the refund address, but only on the wallet tab: the paste tab
  // never fills it in by itself, so the person chooses where a refund goes.
  useEffect(() => {
    if (mode === "wallet" && route && route.evm_chain_id !== null && evm.address && refund === "")
      setRefund(evm.address);
  }, [mode, route, evm.address, refund]);

  const pickRoute = (id: string) => {
    setRouteId(id);
    setSessionError(null);
    setRefundShown(false);
    // Without splitting there is one price on screen at a time; with it, each part is kept.
    if (!split) setLegs([]);
  };

  const turnSplitOn = () => {
    setSplit(true);
    setAmountText(centsToApi(remaining));
    setAmountShown(false);
  };

  const setStage = useCallback((id: string, stage: PayStage) => {
    setLegs((l) =>
      l.some((x) => x.session.id === id && x.stage !== stage)
        ? l.map((x) => (x.session.id === id ? { ...x, stage } : x))
        : l,
    );
  }, []);

  /** Ask for a price. `cents` is the amount of this part; `replace` swaps an expired part's price in place. */
  const start = useCallback(
    async (r: Route, refundTo: string, cents: bigint, partial: boolean, replace?: string) => {
      setSessionError(null);
      setStarting(true);
      try {
        const s = await client.pay.createSession({
          token_id: tokenId,
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
          const left = remainingCents(outstanding, [...legs, leg]);
          setAmountText(left > 0n ? centsToApi(left) : "");
          setAmountShown(false);
        }
      } catch (e) {
        setSessionError(
          e instanceof ApiError && e.code === "invalid_refund_address" ? "refund" : "failed",
        );
      } finally {
        setStarting(false);
      }
    },
    [tokenId, outstanding, legs],
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
  const covered = split && legs.length > 0 && remaining === 0n;
  const allPaid =
    covered &&
    legs.every(
      (l) =>
        l.stage === "paid" ||
        l.stage === "expired" ||
        l.stage === "refunded" ||
        l.stage === "failed",
    );

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

  const submit = () => {
    setRefundShown(true);
    setAmountShown(true);
    if (!route || refundProblem !== null || amountProblem !== null) return;
    const cents = split ? (legCents(amountText) ?? 0n) : remainingCents(outstanding, []);
    void start(route, refund, cents, split);
  };

  // The form for one tab. Both tabs share the state; the wallet tab adds the connect button.
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
      <div className="space-y-4">
        {picker(p.pickUsdc, usdc)}
        {picker(p.pickVolatile, volatile)}
      </div>
      {!split && legs.length === 0 ? (
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

  const shown = new Set(legs.map((l) => l.session.deposit_address));
  const past = earlier.filter((e) => !shown.has(e.address));
  const pastNote =
    past.length > 0 ? (
      <section
        aria-label={p.earlierTitle}
        className="surface-card space-y-2 p-4 text-[14px] sm:p-6"
      >
        <h2 className="text-[16px] font-semibold">{p.earlierTitle}</h2>
        <p className="caption">{p.earlierBody}</p>
        <ul className="space-y-1">
          {past.map((e) => (
            <li key={e.address} className="tabular break-all">
              {e.route} · {e.address}
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  const parts =
    split && legs.length > 0 ? (
      <section aria-label={p.mixPartsTitle} className="surface-card space-y-3 p-4 sm:p-6">
        <h2 className="text-[18px] leading-[26px] font-semibold">{p.mixPartsTitle}</h2>
        <ul className="divide-y divide-border">
          {legs.map((l, i) => (
            <li
              key={l.session.id}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-[14px]"
            >
              <span className="font-medium">{p.mixPart(i + 1)}</span>
              <span className="tabular">{formatUsd(l.cents)}</span>
              <span className="caption w-full">
                {p.routeLabel(l.route.payer_asset, CHAINS[chainOfRoute(l.route) ?? "base"])} ·{" "}
                {p.legStage[l.stage]}
              </span>
            </li>
          ))}
        </ul>
        <p className="flex justify-between text-[15px] font-semibold">
          <span>{covered ? p.mixCovered : p.mixStillToPay}</span>
          <span className="tabular">{formatUsd(remaining)}</span>
        </p>
      </section>
    ) : null;

  const prices = open
    ? legs.map((l, i) => (
        <SessionView
          key={l.session.id}
          session={l.session}
          route={l.route}
          partLabel={split ? p.mixPart(i + 1) : undefined}
          onStage={(stage) => setStage(l.session.id, stage)}
          onNewQuote={() => void start(l.route, refund, l.cents, split, l.session.id)}
          starting={starting}
        />
      ))
    : null;

  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start lg:gap-8">
      <div className="min-w-0 space-y-6">
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
            <Tabs
              fill
              label={p.tabsLabel}
              value={mode}
              onValueChange={(id) => setMode(id as Mode)}
              items={[
                { id: "paste", label: p.tabPaste, panel: form("paste") },
                { id: "wallet", label: p.tabWallet, panel: form("wallet") },
              ]}
            />
            {split || legs.length === 0 ? <p className="caption mt-4">{p.mixSplitHelp}</p> : null}
          </Card>
        )}
      </div>
      <div className="min-w-0 space-y-6">
        {allPaid && legs.some((l) => l.stage === "paid") ? (
          <div
            role="status"
            className="surface-card flex items-center gap-2 p-6 text-[20px] font-semibold"
          >
            <CheckCircle2 size={22} strokeWidth={1.5} className="text-success-text" aria-hidden />
            {p.mixAllPaid}
          </div>
        ) : null}
        {parts}
        {pastNote}
        {prices}
        {open && starting ? <Card title={p.getting} state="loading" /> : null}
        {open && sessionError === "failed" ? (
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
