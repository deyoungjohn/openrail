"use client";

import type { CashoutQuote } from "@openrail/api-client";
import { CheckCircle2 } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { copy } from "@/copy";
import { dashClient } from "@/lib/client";
import { MOCK_MODE } from "@/lib/auth";
import { formatUsd } from "@/lib/format";
import { formatToken, refundAddressProblem } from "@/lib/pay";
import { tokenLabel, type CashoutRow } from "@/lib/cashout";
import { useBalance } from "@/lib/use-balance";
import { useEarnings } from "@/lib/use-earnings";
import { useAsync } from "@/lib/use-async";
import { costShare, parseUsdcInput } from "@/lib/w5";
import { useActions } from "@/wallet/actions";
import { useNear } from "@/wallet/near";
import { useAuth } from "../auth/auth-provider";
import { AddressChip } from "../ui/address-chip";
import { Button } from "../ui/button";
import { CHAINS, type ChainId } from "../ui/chain-badge";
import { Countdown } from "../ui/countdown";
import { Input, Select } from "../ui/input";
import { RangeSlider } from "../ui/range-slider";
import { enabledModules } from "@/enabled";
import { collectPayoutSections } from "@/lib/module-settings";
import { Tabs } from "../ui/tabs";
import { CashoutFlow } from "./cashout-flow";
import { CashoutHistory } from "./cashout-history";
import { CashoutOverview } from "./cashout-overview";
import { NearWalletView } from "../wallet-buttons";
import { ErrorNote } from "@/components/ui/error-note";

// Cash-out destinations (blueprint 2.9). Not BNB Chain: it cannot be quoted (K11).
type Destination = Exclude<ChainId, "bnb"> | "confidential";
// "confidential" moves the merchant's own balance to their private (Near Intents confidential) balance: no address is
// asked, it is their own account. Offered only when the build says the API has it switched on.
const PRIVATE_BALANCE = process.env.NEXT_PUBLIC_CONFIDENTIAL_INTENTS === "1";
const DESTINATIONS: readonly Destination[] = [
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "solana",
  "ethereum",
  "near",
  ...(PRIVATE_BALANCE ? (["confidential"] as const) : []),
];

/** A route that costs this share of the cash-out or more is called out. */
const HIGH_COST_TENTHS = 50n;

type Phase = "form" | "asking" | "quoted" | "signing" | "sent";

function highCost(share: string | null): boolean {
  if (!share) return false;
  const [w = "0", f = "0"] = share.replace("%", "").split(".");
  return BigInt(w) * 10n + BigInt(f) >= HIGH_COST_TENTHS;
}

const payoutSections = collectPayoutSections(enabledModules);

export function CashoutScreen() {
  const t = copy.cashout;
  const near = useNear();
  const actions = useActions();
  const [amountText, setAmountText] = useState("");
  const [chain, setChain] = useState<Destination>("base");
  const [address, setAddress] = useState("");
  const [shown, setShown] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [quote, setQuote] = useState<CashoutQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const idem = useRef(crypto.randomUUID());
  const [list, reloadList] = useAsync(
    async () => (await dashClient.cashout.list()).data as CashoutRow[],
    [],
  );
  const [earned] = useEarnings();
  const [flow, setFlow] = useState<CashoutRow | null>(null);

  const auth = useAuth();
  const account = auth.state.status === "signedIn" ? auth.state.accountId : null;
  const [balance] = useBalance(MOCK_MODE ? null : account);
  // The money is taken from one token: the one the business holds the most of (a payment from Base is a balance of
  // the Base USDC token, and moving a token that is not held is refused by the chain). What can be cashed out now is
  // that balance, in whole cents (cut, never rounded up).
  const held =
    balance.state === "ready"
      ? balance.data.lines.reduce<(typeof balance.data.lines)[number] | null>(
          (best, l) => (best === null || l.units > best.units ? l : best),
          null,
        )
      : null;
  const availableCents = held ? held.units / 10_000n : null;
  const units = parseUsdcInput(amountText);
  const percent =
    availableCents !== null && availableCents > 0n && units !== null
      ? Math.min(100, Number(((units / 10_000n) * 100n) / availableCents))
      : 0;
  const setPercent = (p: number) => {
    if (availableCents === null) return;
    const cents = p >= 100 ? availableCents : (availableCents * BigInt(Math.round(p))) / 100n;
    setAmountText(`${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`);
    setPhase("form");
    setQuote(null);
  };
  const isPrivate = chain === "confidential";
  const sendTo = isPrivate ? (account ?? "") : address.trim();
  const addressProblem = isPrivate ? null : refundAddressProblem(chain as ChainId, address);
  const canSign = MOCK_MODE || near.accountId !== null;
  const share = useMemo(
    () => (quote && units ? costShare(quote.route_cost_usd, BigInt(quote.amount)) : null),
    [quote, units],
  );

  const ask = async () => {
    setShown(true);
    setError(null);
    if (units === null || addressProblem !== null) return;
    setPhase("asking");
    setExpired(false);
    try {
      const q = await dashClient.cashout.quote(
        {
          amount: units.toString(),
          destination_chain: chain,
          address: sendTo,
          ...(held ? { source_asset: held.tokenId } : {}),
        },
        { idempotencyKey: idem.current },
      );
      setQuote(q);
      setExpired(Date.parse(q.deadline) <= Date.now());
      setPhase("quoted");
    } catch {
      idem.current = crypto.randomUUID();
      setError(t.quoteFailed);
      setPhase("form");
    }
  };

  const sign = async () => {
    if (!quote) return;
    setError(null);
    setPhase("signing");
    try {
      const hash = await actions.cashOut({
        tokenId: quote.source_asset,
        depositAddress: quote.deposit_address,
        amount: quote.amount,
      });
      setPhase("sent");
      const id = (quote as { id?: string }).id;
      if (id) {
        // Attach the signed transaction (when the wallet gave one) and show where the money goes from here.
        try {
          const row = hash
            ? await dashClient.cashout.sent(id, hash)
            : await dashClient.cashout.get(id);
          setFlow(row as CashoutRow);
        } catch {
          // The cash-out is signed and on its way; the table below still lists it.
        }
        reloadList();
      }
    } catch {
      setError(t.signFailed);
      setPhase("quoted");
    }
  };

  const busy = phase === "asking" || phase === "signing";

  // Public and private: the public balance is this page; an enabled module adds its own tab (the private balance).
  const withSections = (publicPanel: ReactNode) =>
    payoutSections.length === 0 ? (
      publicPanel
    ) : (
      <Tabs
        label={t.tabsLabel}
        items={[
          {
            id: "public",
            label: t.tabPublic,
            panel: <div className="space-y-6 py-1">{publicPanel}</div>,
          },
          ...payoutSections.map(({ id, label, Panel }) => ({ id, label, panel: <Panel /> })),
        ]}
      />
    );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-[32px] leading-10 font-bold">{t.title}</h1>
        <p className="text-[15px]">{t.intro}</p>
      </header>

      {withSections(
        <Tabs
          fill
          label={t.tabsLabel}
          items={[
            {
              id: "cash",
              label: t.tabCashOut,
              panel: (
                <div className="space-y-6 py-1">
                  {phase === "sent" && quote ? (
                    <div role="status" className="surface-card space-y-3 p-6">
                      <p className="flex items-center gap-2 text-[20px] font-semibold">
                        <CheckCircle2
                          size={22}
                          strokeWidth={1.5}
                          className="text-success-text"
                          aria-hidden
                        />
                        {t.sent}
                      </p>
                      <p className="text-[15px]">{t.sentBody}</p>
                      <div className="flex justify-center">
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setPhase("form");
                            setQuote(null);
                            setAmountText("");
                            idem.current = crypto.randomUUID();
                          }}
                        >
                          {t.again}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <form
                      noValidate
                      className="surface-card space-y-2 p-6"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void ask();
                      }}
                    >
                      {availableCents !== null ? (
                        <p className="text-[15px]" data-testid="cashout-available">
                          {t.available}{" "}
                          <span className="tabular font-semibold">{formatUsd(availableCents)}</span>
                          {held ? (
                            <span className="caption"> {tokenLabel(held.tokenId)}</span>
                          ) : null}
                        </p>
                      ) : null}
                      <Input
                        label={t.amount}
                        helper={t.amountHelp}
                        inputMode="decimal"
                        value={amountText}
                        onChange={(e) => {
                          setAmountText(e.target.value);
                          setPhase("form");
                          setQuote(null);
                        }}
                        error={shown && units === null ? t.badAmount : undefined}
                        disabled={busy}
                      />
                      {availableCents !== null && availableCents > 0n ? (
                        <RangeSlider
                          aria-label={t.slider}
                          value={percent}
                          onChange={setPercent}
                          snapPoints={[0, 25, 50, 75, 100]}
                          marks={[
                            { value: 25, label: "25%" },
                            { value: 50, label: "50%" },
                            { value: 75, label: "75%" },
                            { value: 100, label: "100%" },
                          ]}
                          format={(p) => `${p}%`}
                          disabled={busy}
                        />
                      ) : null}
                      <Select
                        label={t.sendTo}
                        value={chain}
                        onValueChange={(v) => {
                          setChain(v as Destination);
                          setPhase("form");
                          setQuote(null);
                        }}
                        disabled={busy}
                      >
                        {DESTINATIONS.map((c) => (
                          <option key={c} value={c}>
                            {c === "confidential" ? t.privateBalance : CHAINS[c]}
                          </option>
                        ))}
                      </Select>
                      {isPrivate ? (
                        <p className="caption">{t.privateHelp}</p>
                      ) : (
                        <Input
                          label={t.address}
                          helper={t.addressHelp}
                          value={address}
                          autoCapitalize="none"
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(e) => {
                            setAddress(e.target.value.trim());
                            setPhase("form");
                            setQuote(null);
                          }}
                          error={(shown && addressProblem) || undefined}
                          disabled={busy}
                        />
                      )}
                      <ErrorNote>{error && phase === "form" ? error : null}</ErrorNote>
                      <div className="flex justify-center">
                        <Button type="submit" loading={phase === "asking"}>
                          {phase === "asking" ? t.gettingQuote : t.getQuote}
                        </Button>
                      </div>
                    </form>
                  )}

                  {quote && (phase === "quoted" || phase === "signing") ? (
                    <>
                      {/* The cost comes before anything that signs. */}
                      <section aria-label={t.costTitle} className="surface-card space-y-4 p-6">
                        <h2 className="text-[18px] leading-[26px] font-semibold">{t.costTitle}</h2>
                        <dl className="space-y-3">
                          <div>
                            <dt className="caption">{t.cost}</dt>
                            <dd className="tabular text-[28px] leading-[1.1] font-bold">
                              ${quote.route_cost_usd}
                            </dd>
                            {share ? (
                              <dd
                                className={
                                  highCost(share)
                                    ? "text-warning text-[14px] font-medium"
                                    : "caption"
                                }
                              >
                                {t.costShare(share)}
                              </dd>
                            ) : null}
                          </div>
                          <div>
                            <dt className="caption">{t.youReceive}</dt>
                            <dd className="tabular text-[18px] font-semibold">
                              {formatToken(quote.amount_out, 6)} USDC{" "}
                              <span className="text-[15px] font-normal text-muted">
                                {isPrivate ? t.onPrivate : t.on(CHAINS[chain as ChainId])}
                              </span>
                            </dd>
                          </div>
                          <div>
                            <dt className="caption">{t.to}</dt>
                            <dd>
                              <AddressChip
                                value={quote.destination_address}
                                chain={isPrivate ? undefined : (chain as ChainId)}
                                head={10}
                                tail={8}
                              />
                            </dd>
                          </div>
                        </dl>
                        <p className="caption">{t.bufferNote}</p>
                        {highCost(share) ? <p className="caption">{t.costHigh}</p> : null}
                      </section>

                      {expired ? (
                        <div role="status" className="surface-card space-y-3 p-6">
                          <h2 className="text-[18px] leading-[26px] font-semibold">
                            {t.expiredTitle}
                          </h2>
                          <p className="text-[15px]">{t.expiredBody}</p>
                          <Button onClick={() => void ask()}>{t.newQuote}</Button>
                        </div>
                      ) : (
                        <div className="surface-card space-y-4 p-6">
                          <p className="flex items-center justify-between text-[14px]">
                            <span className="caption">{t.expiresIn}</span>
                            <span onClick={undefined}>
                              <Countdown
                                target={Date.parse(quote.deadline)}
                                units={
                                  Date.parse(quote.deadline) - Date.now() > 86_400_000
                                    ? ["days", "hours", "minutes"]
                                    : Date.parse(quote.deadline) - Date.now() > 3_600_000
                                      ? ["hours", "minutes", "seconds"]
                                      : ["minutes", "seconds"]
                                }
                                variant="compact"
                              />
                            </span>
                          </p>
                          {!canSign ? (
                            <div className="space-y-2">
                              <p className="text-[14px]">{t.signInFirst}</p>
                              <NearWalletView {...near} />
                            </div>
                          ) : null}
                          <ErrorNote>{error ? error : null}</ErrorNote>
                          <Button
                            onClick={() => void sign()}
                            loading={phase === "signing"}
                            disabled={!canSign}
                          >
                            {phase === "signing" ? t.signing : t.sign}
                          </Button>
                        </div>
                      )}
                    </>
                  ) : null}

                  {flow ? (
                    <CashoutFlow
                      initial={flow}
                      onChange={(row) => {
                        if (row.status !== flow.status) reloadList();
                      }}
                    />
                  ) : null}
                </div>
              ),
            },
            {
              id: "stats",
              label: t.tabStats,
              panel: (
                <div className="space-y-6 py-1">
                  <>
                    <CashoutOverview
                      earnings={earned.state === "ready" ? earned.data.earnings : []}
                      cashouts={list.state === "ready" ? list.data : []}
                      loading={earned.state === "loading" || list.state === "loading"}
                    />
                    <CashoutHistory
                      rows={list.state === "ready" ? list.data : []}
                      state={list.state}
                      onRetry={reloadList}
                    />
                  </>
                </div>
              ),
            },
          ]}
        />,
      )}
    </div>
  );
}
