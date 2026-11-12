"use client";

import { useState } from "react";
import { AddressChip } from "@/components/ui/address-chip";
import type { ChainId } from "@/components/ui/chain-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorNote } from "@/components/ui/error-note";
import { Input, Select } from "@/components/ui/input";
import { dashClient } from "@/lib/client";
import { parseUsdcInput } from "@/lib/w5";
import { useNear } from "@/wallet/near";
import { checkIntent, signedIntent, type WithdrawIntent } from "./withdraw";

/** The asset the shield moved: USDC on NEAR. A withdraw takes the same asset out. */
const SOURCE_ASSET = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const CHAINS: { id: string; label: string; chain: ChainId }[] = [
  { id: "base", label: "Base", chain: "base" },
  { id: "arbitrum", label: "Arbitrum", chain: "arbitrum" },
  { id: "ethereum", label: "Ethereum", chain: "ethereum" },
  { id: "solana", label: "Solana", chain: "solana" },
];

type Step = "form" | "quoting" | "review" | "signing" | "following" | "done" | "failed";

interface Quoted {
  depositAddress: string;
  amountIn: string;
  amountOut: string;
}

const usd = (units: string): string => {
  const n = BigInt(units);
  return `$${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
};

function problemText(code: string | undefined): string {
  switch (code) {
    case "session_required":
      return "Sign in with your wallet again, then retry.";
    case "invalid_address":
      return "That address is not valid for the chain you picked.";
    case "invalid_amount":
      return "That amount is not valid.";
    case "confidential_intents_disabled":
      return "Private balance withdrawals are not switched on yet.";
    default:
      return `We couldn't do that. Nothing was moved${code ? ` (${code})` : ""}.`;
  }
}

/** Withdraw from the private balance to a wallet: quote, sign the one message in your wallet, follow it to the end. */
export function WithdrawCard({ approxUnits }: { approxUnits: bigint }) {
  const near = useNear();
  const [chain, setChain] = useState("base");
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quoted | null>(null);
  const [status, setStatus] = useState<string>("");

  const units = parseUsdcInput(amount);
  const amountBad = units === null;
  const addressBad = address.trim().length < 8;

  const getQuote = async () => {
    setShown(true);
    setProblem(null);
    if (amountBad || addressBad || units === null) return;
    setStep("quoting");
    try {
      const r = (await dashClient.confidential.withdrawQuote({
        amount: units.toString(),
        source_asset: SOURCE_ASSET,
        destination_chain: chain,
        address: address.trim(),
      })) as { quote?: Record<string, unknown> };
      const q = r.quote ?? {};
      if (typeof q.depositAddress !== "string") throw new Error("no_deposit_address");
      setQuote({
        depositAddress: q.depositAddress,
        amountIn: String(q.amountIn ?? units),
        amountOut: String(q.amountOut ?? "0"),
      });
      setStep("review");
    } catch (e) {
      setProblem(problemText((e as { code?: string }).code));
      setStep("form");
    }
  };

  const signAndSend = async () => {
    if (quote === null) return;
    setProblem(null);
    setStep("signing");
    try {
      const generated = (await dashClient.confidential.withdrawIntent(quote.depositAddress)) as {
        intent: WithdrawIntent;
      };
      checkIntent(generated.intent, {
        depositAddress: quote.depositAddress,
        accountId: near.accountId,
      });
      const p = generated.intent.payload;
      const signed = await near.signMessage({
        message: p.message,
        recipient: p.recipient,
        nonce: p.nonce,
      });
      await dashClient.confidential.withdrawSubmit(signedIntent(generated.intent, signed));
      setStep("following");
      // Follow it until the provider says it is over (about two minutes at most).
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = (await dashClient.confidential.withdrawStatus(quote.depositAddress)) as {
          status?: string;
        };
        setStatus(String(s.status ?? ""));
        if (s.status === "SUCCESS") return setStep("done");
        if (s.status === "REFUNDED" || s.status === "FAILED") {
          console.log("withdraw ended", quote.depositAddress, s);
          setProblem(
            `It did not complete (${s.status}). The money stays in your private balance. Deposit address: ${quote.depositAddress}`,
          );
          return setStep("failed");
        }
      }
      setProblem("Still on its way. You can close this page; it will arrive.");
      setStep("failed");
    } catch (e) {
      const code = (e as { code?: string; message?: string }).code;
      const msg = (e as Error).message ?? "";
      // Say what failed: the code of the API's answer, or the error's own words (kept short), never just "couldn't".
      console.error("withdraw failed", e);
      setProblem(
        msg === "WALLET_CANCELLED" || /reject|declin|cancel/i.test(msg)
          ? "You declined it in your wallet. Nothing was moved."
          : msg === "SIGNMESSAGE_UNSUPPORTED"
            ? "This wallet cannot sign this message. Use another NEAR wallet."
            : problemText(code ?? (msg ? msg.slice(0, 60) : undefined)),
      );
      setStep("review");
    }
  };

  const busy = step === "quoting" || step === "signing" || step === "following";
  const approx = approxUnits > 0n ? usd(approxUnits.toString()) : null;

  return (
    <Card title="Withdraw from your private balance">
      <div className="space-y-3">
        <p className="caption">
          {approx
            ? `About ${approx} has been moved into your private balance. It is not shown here yet, so keep the amount at or below that.`
            : "Move money from your private balance to a wallet on the chain you choose."}
        </p>

        {step === "review" || step === "signing" || step === "following" || step === "done" ? (
          <dl className="space-y-2 text-[14px]">
            <div className="flex justify-between gap-3">
              <dt className="caption">You withdraw</dt>
              <dd className="tabular font-medium">{quote ? usd(quote.amountIn) : ""}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="caption">You receive</dt>
              <dd className="tabular font-medium">{quote ? usd(quote.amountOut) : ""}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="caption">To</dt>
              <dd>
                <AddressChip
                  value={address.trim()}
                  chain={CHAINS.find((c) => c.id === chain)?.chain}
                  head={8}
                  tail={6}
                />
              </dd>
            </div>
          </dl>
        ) : (
          <>
            <Select label="Network" value={chain} onValueChange={setChain}>
              {CHAINS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
            <Input
              label="Wallet address"
              value={address}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setAddress(e.target.value.trim())}
              error={shown && addressBad ? "Enter the address you want it sent to." : undefined}
            />
            <Input
              label="Amount (USDC)"
              value={amount}
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
              error={shown && amountBad ? "Enter an amount, for example 5.00." : undefined}
            />
          </>
        )}

        {step === "following" ? (
          <p role="status" className="text-[14px]">
            Sent. Waiting for it to arrive
            {status ? `: ${status.toLowerCase().replaceAll("_", " ")}` : ""}.
          </p>
        ) : null}
        {step === "done" ? (
          <p role="status" className="text-[14px] font-medium">
            Done. The money is in your wallet.
          </p>
        ) : null}
        <ErrorNote>{problem}</ErrorNote>

        <div className="flex items-center justify-center gap-3">
          {step === "form" || step === "quoting" ? (
            <Button loading={step === "quoting"} onClick={() => void getQuote()}>
              {step === "quoting" ? "Getting the price" : "Get price"}
            </Button>
          ) : null}
          {step === "review" || step === "signing" ? (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setStep("form")}>
                Back
              </Button>
              <Button loading={step === "signing"} onClick={() => void signAndSend()}>
                {step === "signing" ? "Waiting for your wallet" : "Withdraw"}
              </Button>
            </>
          ) : null}
          {step === "done" || step === "failed" ? (
            <Button
              variant="secondary"
              onClick={() => {
                setStep("form");
                setQuote(null);
                setProblem(null);
                setStatus("");
              }}
            >
              Start again
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
