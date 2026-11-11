"use client";

import { useEffect, useRef, useState } from "react";
import { copy } from "@/copy";
import { dashClient } from "@/lib/client";
import { flowSteps, isFinished, type CashoutRow } from "@/lib/cashout";
import { AddressChip } from "../ui/address-chip";
import { Card } from "../ui/card";
import type { ChainId } from "../ui/chain-badge";
import { Timeline } from "../ui/timeline";

const EVERY_MS = 4_000;

/**
 * Where the money of one cash-out is, step by step: out of the balance on `intents.near`, received by the bridge,
 * sent on, arrived. It asks the API (which asks the provider and the chain) every few seconds until the cash-out
 * has finished, and each step shows its transaction as soon as there is one.
 */
export function CashoutFlow({
  initial,
  onChange,
}: {
  initial: CashoutRow;
  onChange?: (row: CashoutRow) => void;
}) {
  const t = copy.cashout.flow;
  const [row, setRow] = useState<CashoutRow>(initial);
  const [stale, setStale] = useState(false);
  const notify = useRef(onChange);
  notify.current = onChange;

  useEffect(() => {
    setRow(initial);
  }, [initial]);

  const finished = isFinished(row);
  const id = row.id;
  useEffect(() => {
    if (finished) return;
    let off = false;
    const tick = async () => {
      try {
        const next = (await dashClient.cashout.get(id)) as CashoutRow;
        if (off) return;
        setRow(next);
        setStale(false);
        notify.current?.(next);
      } catch {
        if (!off) setStale(true);
      }
    };
    const timer = setInterval(() => void tick(), EVERY_MS);
    void tick();
    return () => {
      off = true;
      clearInterval(timer);
    };
  }, [id, finished]);

  const destChain = row.destination_chain as ChainId;
  const txFor = (id: string) => {
    if (id === "balance" && row.tx_hash) return <AddressChip value={row.tx_hash} chain="near" tx />;
    if (id === "bridge" && row.near_tx_hashes[0] && row.near_tx_hashes[0] !== row.tx_hash)
      return <AddressChip value={row.near_tx_hashes[0]} chain="near" tx />;
    if (id === "arrived" && row.destination_tx_hashes[0])
      return (
        <AddressChip
          value={row.destination_tx_hashes[0]}
          chain={row.destination_chain === "confidential" ? undefined : destChain}
          tx
        />
      );
    return null;
  };

  const steps = flowSteps(row).map((s) => ({
    id: s.id,
    title: t.steps[s.id](row.destination_chain),
    status: s.status,
    txs: txFor(s.id),
  }));
  const note = t.notes[row.status as keyof typeof t.notes] ?? "";

  return (
    <Card title={t.title}>
      <Timeline steps={steps} />
      <p role="status" className="caption mt-4">
        {note}
      </p>
      <p className="caption mt-1 h-5">{stale ? t.stale : isFinished(row) ? "" : t.live}</p>
    </Card>
  );
}
