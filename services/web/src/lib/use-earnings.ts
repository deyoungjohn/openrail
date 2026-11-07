"use client";

import type { Invoice } from "@openrail/api-client";
import { dashClient } from "./client";
import { earningsFrom, type Earning, type ReceiptLike } from "./earnings";
import { useAsync, type Async } from "./use-async";

export interface EarningsData {
  invoices: Invoice[];
  earnings: Earning[];
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
    return { invoices, earnings: earningsFrom(invoices, byInvoice) };
  }, []);
}
