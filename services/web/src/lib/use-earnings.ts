"use client";

import type { Invoice } from "@openrail/api-client";
import { enabledModules } from "../enabled";
import { dashClient } from "./client";
import {
  earningsFrom,
  type Earning,
  type EarningsSource,
  type ReceiptLike,
  type Stream,
} from "./earnings";
import { useAsync, type Async } from "./use-async";

export interface EarningsData {
  invoices: Invoice[];
  earnings: Earning[];
  meta?: { last_polled_at: string | null; boost_active: boolean };
  failedStreams: Stream[];
}

/** Merge module-declared money sources; one broken source never takes the dashboard down. */
export async function loadModuleEarnings(
  sources: readonly EarningsSource[],
): Promise<{ earnings: Earning[]; failedStreams: Stream[] }> {
  const results = await Promise.allSettled(sources.map((source) => source.load()));
  const earnings: Earning[] = [];
  const failedStreams: Stream[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") earnings.push(...result.value);
    else failedStreams.push(sources[index]?.stream ?? "invoice");
  });
  return { earnings, failedStreams };
}

function moduleSources(): EarningsSource[] {
  return enabledModules.flatMap(({ module }) => {
    const sources = (module as { earningsSources?: EarningsSource[] } | null)?.earningsSources;
    return Array.isArray(sources) ? sources : [];
  });
}

/** Invoices plus the receipts of every invoice that took money: the one source of the dashboard's money-in figures. */
export function useEarnings(): [Async<EarningsData>, () => void] {
  return useAsync(async (): Promise<EarningsData> => {
    const list = await dashClient.invoices.list({ limit: 100 });
    const invoices = list.data;
    const paying = invoices
      .filter(
        (i) =>
          BigInt(i.paid_total ?? "0") > 0n || i.status === "Paid" || i.status === "PartiallyPaid",
      )
      .slice(0, 60);
    const results = await Promise.allSettled(paying.map((i) => dashClient.receipts.list(i.id)));
    const byInvoice: Record<string, ReceiptLike[]> = {};
    results.forEach((r, index) => {
      const inv = paying[index];
      if (inv && r.status === "fulfilled") byInvoice[inv.id] = r.value.data as ReceiptLike[];
    });
    const module = await loadModuleEarnings(moduleSources());
    const earnings = [...earningsFrom(invoices, byInvoice), ...module.earnings].sort(
      (a, b) => b.time - a.time,
    );
    return {
      invoices,
      earnings,
      failedStreams: module.failedStreams,
      ...(list.meta === undefined ? {} : { meta: list.meta }),
    };
  }, []);
}
