/** The checkout module's money-in rows for the dashboard. */
import { dashClient } from "../../lib/client";
import { chainOfReceipt, unitsToCents, type Earning, type ReceiptLike } from "../../lib/earnings";

type EarningsSource = { stream: "checkout"; load(): Promise<Earning[]> };

const TYPES = ["checkout.paid", "checkout.partial", "checkout.paid_late"] as const;

/** This booking's amount in base units. The contract's `checkout_paid` carries `amount` (and `total_paid`). */
function eventAmount(data: Record<string, unknown>): string | null {
  for (const value of [data.received, data.amount, data.total_received, data.total_paid]) {
    if (typeof value === "string" && /^\d+$/.test(value)) return value;
  }
  return null;
}

async function load(): Promise<Earning[]> {
  const seen = new Set<string>();
  const rows: Earning[] = [];
  for (const type of TYPES) {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const batch = await dashClient.events.list({
        type: type as never,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const event of batch.data) {
        const data = (event.data ?? {}) as Record<string, unknown>;
        const tokenId = typeof data.token_id === "string" ? data.token_id : "";
        const bookingTx = typeof data.booking_tx === "string" ? data.booking_tx : "";
        const amount = eventAmount(data);
        if (tokenId === "" || bookingTx === "" || amount === null) continue;
        const key = bookingTx;
        if (seen.has(key)) continue;
        seen.add(key);
        const asset = typeof data.asset === "string" ? data.asset : "";
        const origin = typeof data.origin_tx === "string" ? { hash: data.origin_tx } : null;
        const chain = chainOfReceipt({ asset, origin_tx: origin } as ReceiptLike);
        const orderRef =
          typeof data.order_ref === "string" && data.order_ref !== "" ? data.order_ref : tokenId;
        rows.push({
          id: event.id,
          time: event.created * 1000,
          cents: unitsToCents(BigInt(amount)),
          payer: "Anonymous",
          product: `Checkout ${orderRef}`,
          stream: "checkout",
          chain,
          txHash: bookingTx,
          invoiceId: tokenId,
        });
      }
      const next = batch.next_cursor ?? null;
      if (next === null || next === cursor) break;
      cursor = next;
    }
  }
  return rows.sort((a, b) => b.time - a.time);
}

export const earningsSources: EarningsSource[] = [{ stream: "checkout", load }];
