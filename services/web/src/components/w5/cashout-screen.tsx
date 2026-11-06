"use client";

import type { CashoutQuote } from "@openrail/api-client";
import { CheckCircle2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { copy } from "@/copy";
import { dashClient } from "@/lib/client";
import { MOCK_MODE } from "@/lib/auth";
import { formatToken, refundAddressProblem } from "@/lib/pay";
import { costShare, parseUsdcInput } from "@/lib/w5";
import { useActions } from "@/wallet/actions";
import { useNear } from "@/wallet/near";
import { AddressChip } from "../ui/address-chip";
import { Button } from "../ui/button";
import { CHAINS, type ChainId } from "../ui/chain-badge";
import { Countdown } from "../ui/countdown";
import { Input, Select } from "../ui/input";
import { NearWalletView } from "../wallet-buttons";

// Cash-out destinations (blueprint 2.9). Not BNB Chain: it cannot be quoted (K11).
type Destination = Exclude<ChainId, "bnb">;
const DESTINATIONS: readonly Destination[] = [
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "solana",
  "ethereum",
  "near",
];

/** A route that costs this share of the cash-out or more is called out. */
const HIGH_COST_TENTHS = 50n;

type Phase = "form" | "asking" | "quoted" | "signing" | "sent";

function highCost(share: string | null): boolean {
  if (!share) return false;
  const [w = "0", f = "0"] = share.replace("%", "").split(".");
  return BigInt(w) * 10n + BigInt(f) >= HIGH_COST_TENTHS;
}

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

  const units = parseUsdcInput(amountText);
  const addressProblem = refundAddressProblem(chain, address);
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
        { amount: units.toString(), destination_chain: chain, address: address.trim() },
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
      await actions.cashOut({
        tokenId: quote.source_asset,
        depositAddress: quote.deposit_address,
        amount: quote.amount,
      });
      setPhase("sent");
    } catch {
      setError(t.signFailed);
      setPhase("quoted");
    }
  };

  const busy = phase === "asking" || phase === "signing";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-[32px] leading-10 font-bold">{t.title}</h1>
        <p className="text-[15px]">{t.intro}</p>
      </header>

      {phase === "sent" && quote ? (
        <div role="status" className="surface-card space-y-3 p-6">
          <p className="flex items-center gap-2 text-[20px] font-semibold">
            <CheckCircle2 size={22} strokeWidth={1.5} className="text-success-text" aria-hidden />
            {t.sent}
          </p>
          <p className="text-[15px]">{t.sentBody}</p>
        </div>
      ) : (
        <form
          noValidate
          className="surface-card space-y-6 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
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
          <Select
            label={t.sendTo}
            value={chain}
            onChange={(e) => {
              setChain(e.target.value as Destination);
              setPhase("form");
              setQuote(null);
            }}
            disabled={busy}
          >
            {DESTINATIONS.map((c) => (
              <option key={c} value={c}>
                {CHAINS[c]}
              </option>
            ))}
          </Select>
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
          {error && phase === "form" ? (
            <p role="alert" className="text-danger-text text-[14px]">
              {error}
            </p>
          ) : null}
          <Button type="submit" loading={phase === "asking"}>
            {phase === "asking" ? t.gettingQuote : t.getQuote}
          </Button>
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
                    className={highCost(share) ? "text-warning text-[14px] font-medium" : "caption"}
                  >
                    {t.costShare(share)}
                  </dd>
                ) : null}
              </div>
              <div>
                <dt className="caption">{t.youReceive}</dt>
                <dd className="tabular text-[18px] font-semibold">
                  {formatToken(quote.amount_out, 6)} USDC{" "}
                  <span className="text-[15px] font-normal text-muted">{t.on(CHAINS[chain])}</span>
                </dd>
              </div>
              <div>
                <dt className="caption">{t.to}</dt>
                <dd>
                  <AddressChip value={quote.destination_address} chain={chain} head={10} tail={8} />
                </dd>
              </div>
            </dl>
            <p className="caption">{t.bufferNote}</p>
            {highCost(share) ? <p className="caption">{t.costHigh}</p> : null}
          </section>

          {expired ? (
            <div role="status" className="surface-card space-y-3 p-6">
              <h2 className="text-[18px] leading-[26px] font-semibold">{t.expiredTitle}</h2>
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
                    units={["minutes", "seconds"]}
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
              {error ? (
                <p role="alert" className="text-danger-text text-[14px]">
                  {error}
                </p>
              ) : null}
              <Button onClick={() => void sign()} loading={phase === "signing"} disabled={!canSign}>
                {phase === "signing" ? t.signing : t.sign}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
