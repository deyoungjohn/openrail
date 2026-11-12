"use client";

import { ApiError, type PaySession, type PublicClaim, type Route } from "@openrail/api-client";
import { CheckCircle2, Info } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { copy } from "@/copy";
import { client } from "@/lib/client";
import {
  amountPrefix,
  centsToApi,
  chainOfRoute,
  formatToken,
  payUnits,
  legAmountProblem,
  hashStrings,
  legCents,
  payStage,
  payTimeline,
  type PayStep,
  refundAddressProblem,
  remainingCents,
  spreadLabel,
  type PayStage,
  type PayStatus,
} from "@/lib/pay";
import { formatUsd } from "@/lib/format";
import { usePayWallet } from "@/wallet/pay-wallet";
import { AddressChip } from "../ui/address-chip";
import { Button } from "../ui/button";
import { PageSkeleton } from "../ui/page-skeleton";
import { Card } from "../ui/card";
import { CHAINS } from "../ui/chain-badge";
import { HistoryCard } from "./history-card";
import { InvoiceCard } from "./invoice-card";
import { PaymentDialog } from "./payment-dialog";
import { RouteSelects } from "./route-selects";
import { Countdown } from "../ui/countdown";
import { Input } from "../ui/input";
import { Modal } from "../ui/modal";
import { Tabs } from "../ui/tabs";
import { WalletConnectView } from "../wallet-buttons";
import { QrPanel } from "../ui/qr-panel";
import { EmptyState, ErrorState } from "../ui/state";
import { Timeline } from "../ui/timeline";
import { ErrorNote } from "@/components/ui/error-note";

type Session = PaySession;

/** The pay page's words with plain `string` where the copy file has a literal, so a source can say them differently. */
export type PayWords = {
  -readonly [K in keyof typeof copy.pay]: (typeof copy.pay)[K] extends string
    ? string
    : (typeof copy.pay)[K];
};

/** What the pay flow needs of whatever is being paid: an invoice's claim, or a checkout. */
export interface PayFlowClaim {
  status: string;
  outstanding: string;
  routes: Route[];
}

/**
 * Where the pay flow gets its data and how it dresses the page. The invoice page and the hosted checkout page are the
 * same flow with a different source: one pay card, one pop-over for the price and QR code, one set of steps (so a fix
 * to the pay page reaches both). Without a source the flow pays an invoice.
 */
export interface PayScreenSource {
  load: (tokenId: string) => Promise<PayFlowClaim>;
  listSessions: (tokenId: string, claim: PayFlowClaim) => Promise<Session[]>;
  /** A price can be asked for it. */
  isOpen: (claim: PayFlowClaim) => boolean;
  /** Settled on chain: stop reading it again. */
  isPaid: (claim: PayFlowClaim) => boolean;
  /** The card on the left; `topStage` is how far the payment on screen has got. */
  summary: (
    claim: PayFlowClaim,
    ctx: { received: boolean; topStage: PayStage | null },
  ) => ReactNode;
  /** The page when nothing is left to pay (paid, closed, expired). */
  closed: (claim: PayFlowClaim) => ReactNode;
  /** Words that differ from the invoice page (a checkout says order, not invoice). */
  words?: Partial<PayWords>;
  /** A plain-words reason a price could not be asked, when the source knows one (an expired checkout). */
  sessionNote?: (error: unknown) => string | null;
  /** The flow reads the source again at this interval while it is open and not settled. */
  refreshMs?: number;
}

const PayWordsContext = createContext<PayWords>(copy.pay);
const usePayWords = () => useContext(PayWordsContext);

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "notfound" }
  | { state: "ready"; claim: PayFlowClaim };

const invoiceSource: PayScreenSource = {
  load: (tokenId) => client.pay.getClaim(tokenId),
  listSessions: async (tokenId) => (await client.pay.listSessions(tokenId)).data,
  isOpen: (c) => c.status === "Issued" || c.status === "PartiallyPaid",
  isPaid: (c) => c.status === "Paid",
  summary: (c, { received }) => <InvoiceCard claim={c as PublicClaim} received={received} />,
  closed: (c) => (
    <>
      <InvoiceCard claim={c as PublicClaim} />
      <div role="status" className="surface-card p-6 text-[15px]">
        {c.status === "Paid" ? copy.pay.alreadyPaid : copy.pay.closed}
      </div>
      <HistoryCard claim={c as PublicClaim} />
    </>
  ),
};

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

/** What the page shows and the wallet button sends: the quote rounded up to decimals a wallet can enter. */
const amountOf = (session: Session, route: Route): string =>
  formatToken(
    payUnits(session.amount_in, route.origin_decimals, route.payer_asset),
    route.origin_decimals,
  );

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
  const p = usePayWords();
  const chain = chainOfRoute(route);
  const chainName = chain ? CHAINS[chain] : route.origin_chain;
  const upto = amountPrefix(route) === "upto";
  // Price protection is for coins that move in price (ETH, SOL); a stablecoin swap has no such margin to explain.
  const volatile = route.payer_asset === "ETH" || route.payer_asset === "SOL";
  return (
    <section
      aria-label={partLabel ? `${p.quoteTitle}, ${partLabel}` : p.quoteTitle}
      className="surface-card space-y-3 p-4 sm:p-6"
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
          <dd className="tabular text-[18px] font-semibold">{usdcToUsd(session.amount_out)}</dd>
        </div>
        {upto && volatile ? (
          <div>
            <dt className="caption">{p.margin}</dt>
            <dd className="tabular text-[15px] font-medium">{spreadLabel(session.spread_bps)}</dd>
          </div>
        ) : null}
      </dl>
      {upto && volatile ? <p className="caption">{p.marginNote}</p> : null}
      <p className="text-[14px] leading-5">{p.locked(timeOf(session.deadline))}</p>
    </section>
  );
}

/** Pay straight from the connected wallet instead of copying the address or scanning the code. */
function WalletPay({ session, route }: { session: Session; route: Route }) {
  const p = usePayWords();
  const wallet = usePayWallet(route);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (wallet.kind === null || !wallet.available) return null;

  const send = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const hash = await wallet.pay(
        session.deposit_address,
        BigInt(payUnits(session.amount_in, route.origin_decimals, route.payer_asset)),
      );
      setSent(hash);
      // Tell the provider which transaction it is: the page ticks "You send" without waiting for it to look.
      void client.pay.nudgeDeposit(session.id, hash).catch(() => undefined);
    } catch (e) {
      const code = (e as { code?: number } | null)?.code;
      setProblem(code === 4001 ? p.walletRejected : p.walletFailed);
    } finally {
      setBusy(false);
    }
  };

  const amount = `${amountOf(session, route)} ${route.payer_asset}`;
  return (
    <div className="w-full space-y-3">
      <div className="flex justify-center">
        {wallet.address ? (
          <Button type="button" onClick={() => void send()} loading={busy} disabled={sent !== null}>
            {p.walletPay(amount)}
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={() => wallet.connect()}>
            {p.walletConnect}
          </Button>
        )}
      </div>
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
  onNewQuote,
  starting,
  partLabel,
  onStage,
  onFresh,
  epoch,
}: {
  session: Session;
  route: Route;
  onNewQuote: () => void;
  starting: boolean;
  /** Changes each time the pop-over opens: a hidden countdown must start again on the screen. */
  epoch: number;
  /** `Part 2` when the payment is split. */
  partLabel?: string;
  onStage?: (stage: PayStage) => void;
  /** Called once the status has been read from the server at least once on this page. */
  onFresh?: () => void;
}) {
  const p = usePayWords();
  const now = useNow();
  const [status, setStatus] = useState<PayStatus>(session.status);
  const [hashes, setHashes] = useState<{ origin: string[]; near: string[] }>({
    origin: [],
    near: [],
  });
  const [pollFailed, setPollFailed] = useState(false);
  const [short, setShort] = useState(false);
  const [notes, setNotes] = useState(false);
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
          origin: hashStrings(r.swap_details.origin_chain_tx_hashes),
          near: hashStrings(r.swap_details.near_tx_hashes),
        });
        setPollFailed(false);
        onFresh?.();
      } catch {
        if (!off) setPollFailed(true);
      }
    };
    // The first read is at once, not after the first interval: a payer who just paid sees it ticked sooner.
    void tick();
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
                  <AddressChip value={h} chain={chain ?? undefined} tx />
                </li>
              ))}
              {hashes.near.map((h) => (
                <li key={h}>
                  <p className="caption">{p.payoutTx}</p>
                  <AddressChip value={h} chain="near" tx />
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
    <div className="grid gap-3 md:grid-cols-2 md:items-start md:gap-6">
      {/* Left: what to send and how far it has got. Right: where to send it. Both columns are about as tall, so the
          pop-over stays short enough to fit a laptop screen. */}
      <div className="space-y-3">
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
        ) : null}

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

      {stage === "refunded" || stage === "failed" ? null : (
        <div className="border-border space-y-3 border-t pt-3 md:border-t-0 md:border-l md:pt-0 md:pl-6">
          <QrPanel
            address={session.deposit_address}
            amount={`${amountOf(session, route)} ${route.payer_asset}`}
            chain={chain ?? undefined}
          >
            <WalletPay session={session} route={route} />
          </QrPanel>
          <div className="flex items-center justify-between gap-3 px-1">
            <button
              type="button"
              onClick={() => setNotes(true)}
              className="text-accent-text inline-flex items-center gap-1.5 text-[14px] font-medium hover:underline"
            >
              <Info aria-hidden size={16} strokeWidth={1.5} />
              {p.notesLink}
            </button>
          </div>
          <Modal open={notes} onClose={() => setNotes(false)} title={p.notesTitle}>
            <div className="space-y-4 text-[15px] leading-6">
              <p>{p.sendOnly(route.payer_asset, chain ? CHAINS[chain] : route.origin_chain)}</p>
              <p>
                {short
                  ? p.shortSeen(amountOf(session, route), route.payer_asset)
                  : p.shortRule(amountOf(session, route), route.payer_asset)}
              </p>
            </div>
          </Modal>
          <div className="flex items-center justify-between px-1">
            <span className="caption">{p.timeLeft}</span>
            <Countdown
              key={epoch}
              target={Date.parse(session.deadline)}
              units={["minutes", "seconds"]}
              variant="compact"
              label={p.timeLeft}
              completeLabel={copy.countdown.expired}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface Leg {
  session: Session;
  route: Route;
  cents: bigint;
  stage: PayStage;
}

type Mode = "paste" | "wallet" | "split";

export function PayScreen({ tokenId, source }: { tokenId: string; source?: PayScreenSource }) {
  const flow = source ?? invoiceSource;
  const words = useMemo<PayWords>(() => ({ ...copy.pay, ...(flow.words ?? {}) }), [flow]);
  return (
    <PayWordsContext.Provider value={words}>
      <PayFlow tokenId={tokenId} source={flow} />
    </PayWordsContext.Provider>
  );
}

function PayFlow({ tokenId, source }: { tokenId: string; source: PayScreenSource }) {
  const p = usePayWords();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const [mode, setMode] = useState<Mode>("wallet");
  const [routeId, setRouteId] = useState<string | null>(null);
  const [legs, setLegs] = useState<Leg[]>([]);
  const [starting, setStarting] = useState(false);
  const [sessionError, setSessionError] = useState<null | "failed" | "refund">(null);
  const [sessionNote, setSessionNote] = useState<string | null>(null);
  const [refund, setRefund] = useState("");
  const [refundShown, setRefundShown] = useState(false);
  const [split, setSplit] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [amountShown, setAmountShown] = useState(false);
  const [earlier, setEarlier] = useState<{ address: string; route: string }[]>([]);
  const restored = useRef(false);
  // A reload brings back the prices already made. Until they have been read fresh, the page says it is loading: it must
  // not show "Pay this order" for a few seconds to a payer whose money has already arrived.
  const restoredIds = useRef<Set<string>>(new Set());
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [gaveUp, setGaveUp] = useState(false);
  const [dialog, setDialog] = useState(false);
  const priced = useRef(0);
  // Bumped each time the pop-over opens, so the countdown inside starts again on screen.
  const [epoch, setEpoch] = useState(0);
  const skipOpen = useRef(false);
  const showDialog = () => {
    setEpoch((e) => e + 1);
    setDialog(true);
  };
  useEffect(() => {
    // A price made on this page opens the pop-over by itself; a price brought back by a reload does not (the payer
    // may have paid already: the page shows the state first). Closing it is the payer's choice and is kept.
    if (legs.length > priced.current && !skipOpen.current) showDialog();
    skipOpen.current = false;
    priced.current = legs.length;
  }, [legs.length]);

  useEffect(() => {
    let off = false;
    setLoad((prev) => (prev.state === "ready" ? prev : { state: "loading" }));
    source
      .load(tokenId)
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
  }, [tokenId, tick, source]);

  const claim = load.state === "ready" ? load.claim : null;
  const routes = useMemo(
    () => (claim?.routes ?? []).filter((r) => chainOfRoute(r) !== null),
    [claim],
  );

  // A reload must not lose a price the payer may already have sent money to: the server keeps every
  // price it gave for this invoice. Open ones come back as they were; the rest are listed as earlier.
  useEffect(() => {
    if (restored.current) return;
    if (routes.length === 0) return;
    restored.current = true;
    source
      .listSessions(tokenId, claim as PayFlowClaim)
      .then((data) => {
        const now = Date.now();
        const back: Leg[] = [];
        for (const sess of data) {
          const r = routes.find((x) => x.id === sess.route_id);
          const cents = legCents(sess.amount_usd);
          const open = Date.parse(sess.deadline) > now || sess.status === "success";
          // A price for more than what is still owed is out of date (part of the invoice was paid since).
          const owed = BigInt(claim?.outstanding ?? "0");
          const current = cents !== null && (owed === 0n || cents * 10_000n <= owed);
          if (r && cents !== null && open && current) {
            back.push({
              session: sess,
              route: r,
              cents,
              stage: payStage(sess.status, sess.deadline, now),
            });
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
          skipOpen.current = true;
          for (const k of keep) restoredIds.current.add(k.session.id);
          setLegs(keep);
          setRouteId(keep[keep.length - 1]?.route.id ?? null);
          setSplit(keep.length > 1);
        }
      })
      .catch(() => undefined);
  }, [routes, tokenId, claim, source]);

  // Never wait for ever: if the server does not answer, show the page as it is after a few seconds.
  useEffect(() => {
    const id = setTimeout(() => setGaveUp(true), 6000);
    return () => clearTimeout(id);
  }, []);

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

  // The status at the top follows the payment: when a part is paid, read the invoice again until it says so.
  const anyPaid = legs.some((l) => l.stage === "paid");
  const settledNow = claim ? source.isPaid(claim) : false;
  useEffect(() => {
    if (!anyPaid || settledNow) return;
    let tries = 0;
    const id = setInterval(() => {
      tries += 1;
      setTick((t) => t + 1);
      if (tries >= 15) clearInterval(id);
    }, 4000);
    setTick((t) => t + 1);
    return () => clearInterval(id);
  }, [anyPaid, settledNow]);

  // A source that changes by itself (a checkout: partial, late, refunded, expired) is read again until it is settled,
  // also while nothing can be paid any more (a late payment is refunded while the page is open).
  const loadedNow = claim !== null;
  const refreshMs = source.refreshMs;
  useEffect(() => {
    if (!refreshMs || !loadedNow || settledNow) return;
    const id = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs, loadedNow, settledNow]);

  const route = routes.find((r) => r.id === routeId) ?? null;
  // The wallet of the chosen route's chain family: a Solana route never picks up a cached EVM address.
  const wallet = usePayWallet(route);
  const outstanding = claim?.outstanding ?? "0";
  // What is left to pay once the parts so far are counted.
  const remaining = remainingCents(outstanding, legs);

  // A connected wallet stands in for an empty refund address, so only a missing one is a problem.
  const refundProblem = refundAddressProblem(
    route ? chainOfRoute(route) : null,
    refund.trim() === "" && wallet.address ? wallet.address : refund,
  );
  const amountProblem = split ? legAmountProblem(amountText, remaining) : null;

  const filled = useRef("");
  // A connected wallet fills in the refund address, but only on the wallet tab: the paste tab
  // never fills it in by itself, so the person chooses where a refund goes.
  useEffect(() => {
    if (mode === "wallet" && wallet.address && refund === "") {
      setRefund(wallet.address);
      filled.current = wallet.address;
    } else if (
      filled.current !== "" &&
      refund === filled.current &&
      wallet.address !== filled.current
    ) {
      // The route moved to another chain family: the address filled in for the old one goes with it.
      setRefund(wallet.address ?? "");
      filled.current = wallet.address ?? "";
    }
  }, [mode, route, wallet.address, refund]);

  const pickRoute = (id: string) => {
    setRouteId(id);
    setSessionError(null);
    setRefundShown(false);
    // Without splitting there is one price on screen at a time; with it, each part is kept.
    if (!split) setLegs([]);
  };

  const turnSplitOn = () => {
    // The price on screen is for the whole amount: it stays in "earlier prices"; parts start fresh.
    if (!split) setLegs([]);
    setSplit(true);
    // The first part starts with what is still to pay already filled in.
    const left = remainingCents(outstanding, []);
    setAmountText(left > 0n ? centsToApi(left) : "");
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
      setSessionNote(null);
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
          // The next part starts with what is still to pay already filled in.
          const left = remainingCents(outstanding, [...legs, leg]);
          setAmountText(left > 0n ? centsToApi(left) : "");
          setAmountShown(false);
        }
      } catch (e) {
        const note = source.sessionNote?.(e) ?? null;
        setSessionNote(note);
        setSessionError(
          e instanceof ApiError && e.code === "invalid_refund_address" ? "refund" : "failed",
        );
      } finally {
        setStarting(false);
      }
    },
    [tokenId, outstanding, legs, source],
  );

  if (load.state === "loading") return <PageSkeleton variant="public" />;
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
  const open = source.isOpen(c);
  const topStage: PayStage | null =
    legs.find((l) => l.stage === "paid")?.stage ??
    legs.find((l) => l.stage === "processing")?.stage ??
    legs[legs.length - 1]?.stage ??
    null;
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

  const submit = () => {
    setRefundShown(true);
    setAmountShown(true);
    if (!route || refundProblem !== null || amountProblem !== null) return;
    // A forgotten refund address falls back to the connected wallet (the address the money comes from).
    const refundTo = refund.trim() === "" ? (wallet.address ?? "") : refund;
    const cents = split ? (legCents(amountText) ?? 0n) : remainingCents(outstanding, []);
    void start(route, refundTo, cents, split);
  };

  // The form for one tab. Both tabs share the state; the wallet tab adds the connect button.
  const form = (tab: Mode) => (
    <div className="space-y-4">
      {tab === "paste" || tab === "split" ? (
        <>
          <p role="note" className="rounded-[10px] bg-surface-2 p-3 text-[14px] leading-5">
            {p.exchangeWarn}
          </p>
          <p className="caption">{tab === "split" ? p.mixSplitHelp : p.refundRule}</p>
        </>
      ) : (
        <div className="space-y-2">
          <p className="caption">{p.walletTabHelp}</p>
          <WalletConnectView wallet={wallet} chosen={route !== null} />
        </div>
      )}
      <RouteSelects routes={routes} routeId={routeId} onPick={pickRoute} />
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
          <div className="flex flex-wrap justify-center gap-3">
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
          onFresh={() => setFresh((f) => (f.has(l.session.id) ? f : new Set(f).add(l.session.id)))}
          onNewQuote={() => void start(l.route, refund, l.cents, split, l.session.id)}
          starting={starting}
          epoch={epoch}
        />
      ))
    : null;

  // The least advanced of the payments decides what the steps show: one slow part keeps the whole invoice waiting.
  const order: PayStage[] = ["waiting", "expired", "processing", "failed", "refunded", "paid"];
  const overall: PayStage | null =
    legs.length === 0
      ? null
      : legs.every((l) => l.stage === "paid")
        ? "paid"
        : legs.reduce<PayStage>(
            (low, l) => (order.indexOf(l.stage) < order.indexOf(low) ? l.stage : low),
            "paid",
          );
  const stepStatus = (id: "pick" | "send" | "received" | "paidOut"): PayStep["status"] => {
    if (overall === null) return id === "pick" ? "current" : "todo";
    if (id === "pick") return "done";
    const t = payTimeline(overall);
    const key = id === "send" ? "sent" : id === "received" ? "received" : "paid";
    return t.find((x) => x.id === key)?.status ?? "todo";
  };
  const nextCard = (
    <Card title={p.nextTitle}>
      <p className="caption mb-4" role="status">
        {overall === null
          ? p.nextBody
          : overall === "processing"
            ? p.stepNote.processing
            : overall === "paid"
              ? p.stepNote.paid
              : p.stepNote.waiting}
      </p>
      <Timeline
        steps={(["pick", "send", "received", "paidOut"] as const).map((id) => ({
          id,
          title: p.nextSteps[id],
          status: stepStatus(id),
        }))}
      />
    </Card>
  );

  // Nothing left to pay (paid, cancelled, closed): one centered column, with the whole history of the invoice.
  if (!open) {
    return <div className="mx-auto max-w-2xl space-y-6">{source.closed(c)}</div>;
  }
  if (routes.length === 0) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        {source.summary(c, { received: false, topStage: null })}
        <div className="surface-card">
          <EmptyState title={p.noRoutes} />
        </div>
      </div>
    );
  }

  const waitingFresh = legs.some(
    (l) =>
      restoredIds.current.has(l.session.id) &&
      !fresh.has(l.session.id) &&
      (l.stage === "waiting" || l.stage === "processing"),
  );
  if (waitingFresh && !gaveUp) {
    return (
      <>
        <div className="mx-auto max-w-2xl space-y-6">
          {source.summary(c, { received: false, topStage })}
          <Card state="loading" />
        </div>
        {/* mounted but hidden, so the status of the restored prices is read while the page says it is loading */}
        <PaymentDialog open={false} onClose={() => undefined} title={p.detailsTitle}>
          {prices}
        </PaymentDialog>
      </>
    );
  }

  const unsettled = legs.some((l) => l.stage === "waiting" || l.stage === "processing");
  // The provider delivered the whole amount, but the claim on chain is not booked yet (it takes the watcher a moment,
  // longer when the RPC is busy): the page is already the page of a paid invoice, not a page that asks for money.
  const received =
    legs.some((l) => l.stage === "paid") &&
    (split ? allPaid : legs.every((l) => l.stage === "paid" || l.stage === "expired"));
  if (received) {
    return (
      <>
        <div className="mx-auto max-w-2xl space-y-6">
          {source.summary(c, { received: true, topStage })}
          <div role="status" className="surface-card space-y-2 p-6">
            <p className="flex items-center gap-2 text-[20px] font-semibold">
              <CheckCircle2 size={22} strokeWidth={1.5} className="text-success-text" aria-hidden />
              {split ? p.mixAllPaid : p.receivedTitle}
            </p>
            <p className="text-[15px]">{p.receivedBody}</p>
            <div className="flex justify-center">
              <Button variant="secondary" size="sm" onClick={showDialog}>
                {p.showDetails}
              </Button>
            </div>
          </div>
          {parts}
          {nextCard}
        </div>
        <PaymentDialog open={dialog} onClose={() => setDialog(false)} title={p.detailsTitle}>
          {prices}
        </PaymentDialog>
      </>
    );
  }

  const payCardWithStatus = (
    <Card title={p.pickTitle}>
      {unsettled ? (
        <div className="bg-surface-2 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] p-3">
          <span className="text-[14px] font-medium">{p.inProgress}</span>
          <Button variant="secondary" size="sm" onClick={showDialog}>
            {p.showDetails}
          </Button>
        </div>
      ) : null}
      <p className="caption mb-4">{p.pickHelp}</p>
      <Tabs
        fill
        label={p.tabsLabel}
        value={mode}
        onValueChange={(id) => {
          setMode(id as Mode);
          if (id === "split") turnSplitOn();
          else if (split && legs.length === 0) setSplit(false);
        }}
        items={[
          { id: "wallet", label: p.tabWallet, panel: form("wallet") },
          { id: "paste", label: p.tabPaste, panel: form("paste") },
          { id: "split", label: p.tabSplit, panel: form("split") },
        ]}
      />
    </Card>
  );

  // The page keeps one shape from the first look to the last: the invoice and the pay card level with each other,
  // and what happens next across both of them. The price, address and QR code open in a pop-over that can be closed
  // and opened again; the steps behind it follow the same payment.
  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2 lg:items-stretch lg:gap-8">
        <div className="flex min-w-0 flex-col [&>*]:flex-1">
          {source.summary(c, { received: false, topStage })}
        </div>
        <div className="flex min-w-0 flex-col [&>*]:flex-1">{payCardWithStatus}</div>
        <div className="min-w-0 space-y-6 lg:col-span-2">
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
          {starting ? <Card title={p.getting} state="loading" /> : null}
          {sessionError === "failed" && sessionNote ? (
            <div role="alert" className="surface-card p-6 text-[15px]">
              {sessionNote}
            </div>
          ) : sessionError === "failed" ? (
            <div className="surface-card">
              <ErrorState
                body={split && legs.length > 0 ? p.mixPartFailed : p.sessionError}
                onRetry={route ? submit : undefined}
              />
            </div>
          ) : null}
          {nextCard}
        </div>
      </div>
      <PaymentDialog
        open={dialog && legs.length > 0}
        onClose={() => setDialog(false)}
        title={p.detailsTitle}
      >
        {prices}
      </PaymentDialog>
    </>
  );
}
