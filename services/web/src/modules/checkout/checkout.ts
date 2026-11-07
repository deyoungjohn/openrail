import { formatToken, type PayStage } from "../../lib/pay";

export type CheckoutStatus =
  "pending" | "partial" | "paid" | "late" | "accepted" | "refunded" | "expired" | "needs_attention";

export interface PublicCheckout {
  id: string;
  token_id: string;
  claim_account: string;
  merchant: string;
  order_ref: string;
  amount_usd: string;
  amount_due: string;
  outstanding: string;
  paid_total: string;
  surplus: string;
  status: CheckoutStatus;
  expires_at: string;
  return_url: string | null;
  server_time?: string;
}

export const checkoutCopy = {
  order: (ref: string) => `Order ${ref}`,
  title: (merchant: string) => `Pay ${merchant}`,
  expiresIn: "Order expires in",
  expiredTitle: "This checkout has expired",
  expiredBody:
    "No new price can be created for an expired checkout. Ask the merchant for a new checkout link.",
  paidTitle: "Paid",
  paidBody: "Your payment is complete.",
  settlingTitle: "Payment received, settling",
  settlingBody:
    "We saw your payment on the origin network. It usually finishes in about 30 seconds.",
  waitingTitle: "Waiting for payment",
  waitingBody: "Choose a network and asset to get your payment address.",
  partialTitle: (stillDue: string) => `Partially paid · ${stillDue} still due`,
  partialBody: (paid: string, stillDue: string) =>
    `We received ${paid} so far. Pay the remaining ${stillDue} before the order expires.`,
  lateTitle: "Paid after expiry",
  lateBody:
    "Your payment arrived after the order expired. It is safe and held on chain while the merchant accepts or refunds it to your refund address.",
  needsAttentionTitle: "Needs merchant attention",
  needsAttentionBody:
    "Your payment is held safely on chain while the merchant reviews the order balance.",
  refundedTitle: "Refunded",
  refundedBody: "This late payment is being returned to the refund address you gave.",
  overpaidNote: (extra: string) => `Includes ${extra} above the order amount.`,
  returnToMerchant: "Return to merchant",
  notFoundTitle: "We can't find this checkout",
  notFoundBody: "The link may be wrong or incomplete. Ask the merchant for a fresh link.",
  loadError: "We couldn't load this checkout. Check your connection and try again.",
  expiredQuoteRefused: "This checkout expired while getting your price. No new price was created.",
};

/**
 * The swap provider keeps its deposit address open for three days beyond what we ask for;
 * the deadline shown to a payer is always the one logged on chain (`deadline_requested`, unix s).
 */
export function countdownTargetMs(input: {
  deadline_requested?: number;
  deadline?: string;
  expires_at?: string;
}): number {
  if (typeof input.deadline_requested === "number" && input.deadline_requested > 0) {
    return input.deadline_requested * 1000;
  }
  const iso = input.expires_at ?? input.deadline ?? "";
  return Date.parse(iso);
}

/** Whether a payer may ask for a new quote on this checkout right now. */
export function canQuoteCheckout(checkout: PublicCheckout, nowMs: number): boolean {
  if (checkout.status !== "pending" && checkout.status !== "partial") return false;
  if (BigInt(checkout.outstanding || "0") <= 0n) return false;
  const expiryMs = Date.parse(checkout.expires_at);
  if (!Number.isFinite(expiryMs) || nowMs >= expiryMs) return false;
  return true;
}

export function checkoutStatusLabel(checkout: PublicCheckout): string {
  switch (checkout.status) {
    case "paid":
    case "accepted":
      return checkoutCopy.paidTitle;
    case "partial":
      return checkoutCopy.partialTitle(`$${formatToken(checkout.outstanding, 6)}`);
    case "late":
      return checkoutCopy.lateTitle;
    case "needs_attention":
      return checkoutCopy.needsAttentionTitle;
    case "refunded":
      return checkoutCopy.refundedTitle;
    case "expired":
      return checkoutCopy.expiredTitle;
    case "pending":
      return checkoutCopy.waitingTitle;
  }
}

export interface LiveBanner {
  kind: "waiting" | "settling" | "partial" | "paid" | "late" | "refunded" | "expired";
  title: string;
  body: string;
}

export function checkoutLiveBanner(
  checkout: PublicCheckout,
  quoteStage: PayStage | null,
): LiveBanner {
  if (checkout.status === "needs_attention") {
    return {
      kind: "late",
      title: checkoutCopy.needsAttentionTitle,
      body: checkoutCopy.needsAttentionBody,
    };
  }
  if (checkout.status === "refunded") {
    return { kind: "refunded", title: checkoutCopy.refundedTitle, body: checkoutCopy.refundedBody };
  }
  if (checkout.status === "late") {
    return { kind: "late", title: checkoutCopy.lateTitle, body: checkoutCopy.lateBody };
  }
  if (checkout.status === "paid" || checkout.status === "accepted" || quoteStage === "paid") {
    return { kind: "paid", title: checkoutCopy.paidTitle, body: checkoutCopy.paidBody };
  }
  if (quoteStage === "processing") {
    return { kind: "settling", title: checkoutCopy.settlingTitle, body: checkoutCopy.settlingBody };
  }
  if (checkout.status === "expired") {
    return { kind: "expired", title: checkoutCopy.expiredTitle, body: checkoutCopy.expiredBody };
  }
  if (checkout.status === "partial") {
    const due = `$${formatToken(checkout.outstanding, 6)}`;
    const paid = `$${formatToken(checkout.paid_total, 6)}`;
    return {
      kind: "partial",
      title: checkoutCopy.partialTitle(due),
      body: checkoutCopy.partialBody(paid, due),
    };
  }
  return { kind: "waiting", title: checkoutCopy.waitingTitle, body: checkoutCopy.waitingBody };
}

export function safeReturnUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
