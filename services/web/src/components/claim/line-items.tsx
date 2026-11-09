import type { ReactNode } from "react";
import { formatUsd } from "@/lib/format";

export interface ShownLineItem {
  description: string;
  quantity: number;
  unit_amount_usd: string;
}

/** Cents of one line: quantity times the unit price, to the cent (the API refuses a fraction of a cent). */
function lineCents(item: ShownLineItem): bigint {
  const [whole = "0", frac = ""] = item.unit_amount_usd.split(".");
  const unit = BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
  return BigInt(Math.round(Number(unit) * item.quantity));
}

/** The lines of an invoice: what each one is, how many at what price, and the amount. */
export function LineItems({ items }: { items: readonly ShownLineItem[] }): ReactNode {
  if (items.length === 0) return null;
  return (
    <ul className="divide-y divide-border text-[14px]">
      {items.map((item, i) => (
        <li
          key={`${i}-${item.description}`}
          className="flex items-baseline justify-between gap-3 py-2"
        >
          <span className="min-w-0">
            <span className="block break-words font-medium">{item.description}</span>
            {item.quantity !== 1 ? (
              <span className="caption tabular">
                {item.quantity} × ${item.unit_amount_usd}
              </span>
            ) : null}
          </span>
          <span className="tabular shrink-0">{formatUsd(lineCents(item))}</span>
        </li>
      ))}
    </ul>
  );
}
