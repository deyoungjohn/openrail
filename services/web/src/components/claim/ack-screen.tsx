"use client";

import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { StatusChip } from "../ui/status-chip";
import { EvmWalletView, NearWalletView } from "../wallet-buttons";
import { copy } from "@/copy";
import { api } from "@/lib/api";
import { ACK_CHAIN_IDS } from "@/lib/ack";
import type { Claim } from "@/lib/claim";
import { middleTruncate } from "@/lib/format";
import { useActions } from "@/wallet/actions";
import { EvmAckFailure, signEvmAck } from "@/wallet/evm-ack";
import { useEvm } from "@/wallet/evm";
import { useNear } from "@/wallet/near";
import { ClaimTerms } from "./claim-terms";
import { ClaimStates } from "./claim-states";
import { useClaim } from "./use-claim";

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  42161: "Arbitrum",
  10: "Optimism",
  137: "Polygon",
  56: "BNB Chain",
};

type Phase = "idle" | "signing" | "sending" | "done";

function errorText(e: unknown, claim: Claim): string {
  const a = copy.ack;
  if (e instanceof EvmAckFailure) {
    switch (e.code) {
      case "NO_WALLET":
        return copy.wallet.noEvmWallet;
      case "WRONG_ACCOUNT":
        return a.wrongEvm(claim.debtor?.kind === "evm" ? middleTruncate(claim.debtor.address) : "");
      case "UNSUPPORTED_CHAIN":
        return a.unsupportedChain(ACK_CHAIN_IDS.map((id) => CHAIN_NAMES[id]).join(", "));
      case "CONTRACT_WALLET":
        return a.contractWallet;
      case "REJECTED":
        return a.rejected;
    }
  }
  return a.failed;
}

function ClosedNotice({ claim }: { claim: Claim }) {
  const text =
    claim.status === "Paid"
      ? copy.ack.paid
      : claim.status === "Cancelled"
        ? copy.ack.cancelled
        : copy.ack.closed;
  return (
    <div role="status" className="rounded-[10px] bg-surface-2 p-4 text-[15px]">
      <p className="font-medium">{copy.ack.closedTitle}</p>
      <p className="caption mt-1">{text}</p>
    </div>
  );
}

function AckActions({ claim, onAcked }: { claim: Claim; onAcked: () => void }) {
  const near = useNear();
  const evm = useEvm();
  const actions = useActions();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = phase === "signing" || phase === "sending";
  const debtor = claim.debtor;

  const confirm = async () => {
    setError(null);
    setPhase("signing");
    try {
      if (debtor?.kind === "evm") {
        const { chainId, signature } = await signEvmAck(window.ethereum, claim);
        setPhase("sending");
        await api.relayEvmAck(claim.tokenId, chainId, signature);
      } else if (debtor?.kind === "near") {
        if (near.accountId !== debtor.account) {
          setError(copy.ack.wrongNear(near.accountId ?? "no account", debtor.account));
          setPhase("idle");
          return;
        }
        await actions.acknowledgeNear(claim.rootContract, claim.tokenId);
      }
      setPhase("done");
      onAcked();
    } catch (e) {
      setError(errorText(e, claim));
      setPhase("idle");
    }
  };

  if (!debtor) return <p className="caption">{copy.ack.noDebtor}</p>;

  const near_ok = debtor.kind !== "near" || near.accountId === debtor.account;
  return (
    <div className="space-y-4">
      <p className="caption">{copy.ack.walletNote}</p>
      {debtor.kind === "near" ? (
        <div className="space-y-2">
          <p className="text-[14px]">{copy.ack.expectedNear(debtor.account)}</p>
          <NearWalletView {...near} />
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[14px]">{copy.ack.expectedEvm(middleTruncate(debtor.address))}</p>
          <EvmWalletView {...evm} />
        </div>
      )}
      {error ? (
        <p role="alert" className="text-danger-text text-[14px] leading-5">
          {error}
        </p>
      ) : null}
      <Button
        className="w-full sm:w-auto"
        onClick={() => void confirm()}
        loading={busy}
        disabled={!near_ok && !near.accountId}
      >
        {phase === "signing"
          ? copy.ack.confirming
          : phase === "sending"
            ? copy.ack.sending
            : copy.ack.confirm}
      </Button>
    </div>
  );
}

export function AckScreen({ tokenId }: { tokenId: string }) {
  const [load, retry] = useClaim(tokenId);
  const [acked, setAcked] = useState(false);

  if (load.state !== "ready") return <ClaimStates load={load} onRetry={retry} />;
  const { claim } = load;
  const done = acked || claim.ack !== null;
  const open = claim.status === "Issued" || claim.status === "PartiallyPaid";

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-[28px] leading-9 font-bold">{copy.ack.title}</h1>
        <p className="text-[15px] leading-6">{copy.ack.intro}</p>
      </header>

      <Card>
        <ClaimTerms claim={claim} full />
      </Card>

      <Card>
        {done ? (
          <div role="status" className="space-y-3">
            <StatusChip status={{ kind: "acknowledged" }} />
            <p className="flex items-start gap-2 text-[15px]">
              <CheckCircle2
                size={20}
                strokeWidth={1.5}
                className="text-success-text mt-0.5 shrink-0"
                aria-hidden
              />
              {acked ? copy.ack.doneBody : copy.ack.alreadyBody}
            </p>
          </div>
        ) : open ? (
          <AckActions claim={claim} onAcked={() => setAcked(true)} />
        ) : (
          <ClosedNotice claim={claim} />
        )}
      </Card>
    </div>
  );
}
