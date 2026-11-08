"use client";

import { CheckCircle2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AccountId } from "../ui/account-id";
import { AddressChip } from "../ui/address-chip";
import { Button } from "../ui/button";
import { Card, type ViewState } from "../ui/card";
import { Countdown } from "../ui/countdown";
import { Input } from "../ui/input";
import { StatusChip, type Status } from "../ui/status-chip";
import { NearWalletView } from "../wallet-buttons";
import { copy } from "@/copy";
import { api, MOCK_MODE } from "@/lib/api";
import type { Claim, PaymentLogEntry } from "@/lib/claim";
import { checkTransfer, openQuotes, sha256Hex, type QuoteEntry } from "@/lib/transfer";
import { useActions } from "@/wallet/actions";
import { useNear } from "@/wallet/near";
import { ClaimStates } from "./claim-states";
import { ClaimTerms } from "./claim-terms";
import { useClaim } from "./use-claim";
import { ErrorNote } from "@/components/ui/error-note";

// Core kind: sellable, and a sale needs an acknowledgement. `kind_rules` is not in the claim view
// yet (see handoff), so these are the core defaults from blueprint 2.4.
const CORE_RULES = { ackRequiredForSale: true, sellable: true } as const;

const statusOf = (c: Claim): Status => {
  switch (c.status) {
    case "Paid":
      return { kind: "paid" };
    case "Cancelled":
      return { kind: "cancelled" };
    case "Closed":
      return { kind: "closed" };
    default:
      return c.ack ? { kind: "acknowledged" } : { kind: "sent" };
  }
};

function QuotesCard({ tokenId }: { tokenId: string }) {
  const [log, setLog] = useState<PaymentLogEntry[] | null>(null);
  const [state, setState] = useState<ViewState>("loading");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let off = false;
    setState("loading");
    api
      .getPaymentLog(tokenId)
      .then((l) => {
        if (off) return;
        setLog(l);
        setState("ready");
      })
      .catch(() => !off && setState("error"));
    return () => {
      off = true;
    };
  }, [tokenId, tick]);

  const quotes: QuoteEntry[] = useMemo(
    () => (log ? openQuotes(log, Math.floor(Date.now() / 1000)) : []),
    [log],
  );
  const q = copy.sell;

  return (
    <Card
      title={q.quotesTitle}
      info={q.quotesInfo}
      state={state === "ready" && quotes.length === 0 ? "empty" : state}
      emptyBody={q.quotesEmptyBody}
      emptyTitle={q.quotesEmptyTitle}
      onRetry={() => setTick((t) => t + 1)}
    >
      <p className="caption mb-4">{q.quotesCutoff}</p>
      <ul className="divide-y divide-border">
        {quotes.map((e) => (
          <li
            key={e.quoteId}
            className="grid gap-2 py-3 sm:grid-cols-[80px_1fr_auto] sm:items-center"
          >
            <span className="text-[14px] font-medium">
              <span className="sr-only">{q.route} </span>
              {e.routeId}
            </span>
            <span className="min-w-0">
              <span className="sr-only">{q.payTo} </span>
              <AddressChip value={e.depositAddress} head={8} tail={6} />
            </span>
            <span className="text-[14px]">
              <span className="caption mr-2">{q.expires}</span>
              <Countdown
                target={e.deadline * 1000}
                units={["minutes", "seconds"]}
                variant="compact"
              />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

type Step = "idle" | "preparing" | "prepared" | "signing" | "done";

function SaleForm({ claim }: { claim: Claim }) {
  const near = useNear();
  const actions = useActions();
  const [receiver, setReceiver] = useState("");
  const [docName, setDocName] = useState("");
  const [docHash, setDocHash] = useState("");
  const [docState, setDocState] = useState<"none" | "hashing" | "ready" | "failed">("none");
  const [touched, setTouched] = useState(false);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const s = copy.sell;

  const refusals = checkTransfer(claim, { receiver, assignmentDocHash: docHash }, CORE_RULES);
  // Rules about the claim itself show at once; form-field refusals wait until the seller has typed.
  const visible = refusals.filter(
    (r) => touched || ![0, 4].includes(r.rule) || (r.rule === 0 && receiver !== ""),
  );
  const owner = MOCK_MODE || near.accountId === claim.ownerId;
  const canAct = refusals.length === 0 && owner && docState === "ready";

  const onFile = async (file: File | undefined) => {
    setTouched(true);
    if (!file) {
      setDocName("");
      setDocHash("");
      setDocState("none");
      return;
    }
    setDocName(file.name);
    setDocState("hashing");
    try {
      setDocHash(await sha256Hex(new Uint8Array(await file.arrayBuffer())));
      setDocState("ready");
    } catch {
      setDocHash("");
      setDocState("failed");
    }
  };

  const run = async (next: Step, running: Step, f: () => Promise<void>) => {
    setError(null);
    setStep(running);
    try {
      await f();
      setStep(next);
    } catch (e) {
      setError(e instanceof Error && e.message === "REJECTED" ? s.rejected : s.failed);
      setStep(running === "preparing" ? "idle" : "prepared");
    }
  };

  if (step === "done")
    return (
      <Card>
        <div role="status" className="space-y-3">
          <p className="flex items-center gap-2 text-[18px] font-semibold">
            <CheckCircle2 size={20} strokeWidth={1.5} className="text-success-text" aria-hidden />
            {s.doneTitle}
          </p>
          <p className="text-[15px]">{s.doneBody(receiver)}</p>
        </div>
      </Card>
    );

  return (
    <Card title={s.saleTitle}>
      <div className="space-y-6">
        <Input
          label={s.buyer}
          helper={s.buyerHelp}
          value={receiver}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(e) => {
            setReceiver(e.target.value.trim());
            setTouched(true);
          }}
          disabled={step !== "idle"}
        />

        <div>
          <label htmlFor="assignment-doc" className="text-[14px] leading-5 font-medium">
            {s.doc}
          </label>
          <input
            id="assignment-doc"
            type="file"
            disabled={step !== "idle"}
            onChange={(e) => void onFile(e.target.files?.[0])}
            className="mt-2 block w-full text-[14px] file:mr-3 file:h-9 file:rounded-[10px] file:border file:border-border file:bg-surface file:px-3 file:text-[14px] file:font-medium file:text-text"
          />
          <p className="caption mt-1.5">{s.docHelp}</p>
          {docState === "hashing" ? <p className="caption mt-2">{s.docHashing}</p> : null}
          {docState === "failed" ? (
            <p className="text-danger-text mt-2 text-[14px]">{s.docFailed}</p>
          ) : null}
          {docState === "ready" ? (
            <div className="mt-3">
              <p className="caption">
                {s.docHash} · {docName}
              </p>
              <AddressChip value={docHash} head={64} tail={0} />
            </div>
          ) : null}
        </div>

        <ErrorNote>
          {visible.length > 0 ? (
            <span className="block space-y-1">
              {visible.map((r) => (
                <span key={`${r.rule}-${r.message}`} className="block">
                  {r.message}
                </span>
              ))}
            </span>
          ) : null}
        </ErrorNote>
        {!owner ? (
          <div className="space-y-2">
            <p className="text-[14px]">
              {near.accountId ? (
                <>
                  {s.notOwnerLead} <AccountId value={claim.ownerId} full />
                </>
              ) : (
                s.signInFirst
              )}
            </p>
            <NearWalletView {...near} />
          </div>
        ) : null}
        <ErrorNote>{error ? error : null}</ErrorNote>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="caption">{s.stepOne}</p>
            <Button
              variant="secondary"
              className="w-full"
              disabled={!canAct || step !== "idle"}
              loading={step === "preparing"}
              onClick={() =>
                void run("prepared", "preparing", () =>
                  actions.prepareTransfer(claim.rootContract, claim.tokenId),
                )
              }
            >
              {step === "preparing" ? s.preparing : s.prepare}
            </Button>
          </div>
          <div className="space-y-2">
            <p className="caption">{s.stepTwo}</p>
            <Button
              className="w-full"
              disabled={!canAct || step !== "prepared"}
              loading={step === "signing"}
              onClick={() =>
                void run("done", "signing", () =>
                  actions.nftTransfer(claim.rootContract, {
                    tokenId: claim.tokenId,
                    receiver,
                    memo: docHash.toLowerCase(),
                  }),
                )
              }
            >
              {step === "signing" ? s.signing : s.sign}
            </Button>
          </div>
        </div>
        {step === "prepared" ? (
          <p role="status" className="caption">
            {s.prepared}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

export function TransferScreen({ tokenId }: { tokenId: string }) {
  const [load, retry] = useClaim(tokenId);
  if (load.state !== "ready")
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <ClaimStates load={load} onRetry={retry} />
      </div>
    );
  const { claim } = load;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-[32px] leading-10 font-bold">{copy.sell.title(claim.invoiceNumber)}</h1>
        <p className="text-[15px] leading-6">{copy.sell.intro}</p>
        <StatusChip status={statusOf(claim)} />
      </header>
      <Card>
        <ClaimTerms claim={claim} showOutstanding />
      </Card>
      <QuotesCard tokenId={claim.tokenId} />
      <SaleForm claim={claim} />
    </div>
  );
}
