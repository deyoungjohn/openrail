/**
 * Pure presentation model for the Thank-You Checkout UI Extension block.
 *
 * Requirements from prompts/ag6.md (Update 15):
 * The block shows three states, no other:
 * 1. unpaid: "Order placed" heading, one sentence, a "Pay with stablecoins" button to the pay link, the order total.
 * 2. partial: "Partial payment received", amount paid, amount still due, "Pay remaining balance" button.
 * 3. paid: "Thank you, payment received", "Your payment was confirmed on NEAR.", booking transaction hash(es) as links, summary.
 *
 * Never says thanks before money is booked.
 * An order that is not an Openrail order (route answers 404) renders null (render = false / visible = false).
 */

export interface ThankYouData {
  status?: "unpaid" | "partial" | "paid" | string;
  totalUsd?: string;
  total_usd?: string;
  paidUsd?: string;
  paid_usd?: string;
  remainingUsd?: string;
  remaining_usd?: string;
  payUrl?: string;
  pay_url?: string;
  txHash?: string | null;
  tx_hash?: string | null;
  summary?: string;
  paid?: boolean;
  orderGid?: string;
  order_gid?: string;
}

export interface ThankYouViewModel {
  render: boolean;
  visible: boolean;
  state: "unpaid" | "partial" | "paid" | "hidden";
  heading: string;
  text: string;
  bodyText: string;
  actionLabel?: string;
  ctaLabel?: string;
  actionUrl?: string;
  ctaHref?: string;
  summary?: string;
  summaryText?: string;
  orderTotalText?: string;
  txHash?: string | null;
  txUrl?: string | null;
  explorerUrl?: string;
}

export function buildThankYouViewModel(
  data: ThankYouData | null | undefined,
  orderGidOrRef?: string,
  explorerBaseUrl = "https://nearblocks.io/txns",
): ThankYouViewModel {
  if (!data || data.status === "hidden") {
    return {
      render: false,
      visible: false,
      state: "hidden",
      heading: "",
      text: "",
      bodyText: "",
    };
  }

  const total = data.total_usd ?? data.totalUsd ?? "0.00";
  const status = data.status;

  if (status === "unpaid") {
    const payUrl = data.pay_url ?? data.payUrl ?? "";
    const summary = `Order total: $${total} USD`;
    return {
      render: true,
      visible: true,
      state: "unpaid",
      heading: "Order placed",
      text: "Complete your payment with stablecoins to confirm this order.",
      bodyText: "Complete your payment with stablecoins to confirm this order.",
      actionLabel: "Pay with stablecoins",
      ctaLabel: "Pay with stablecoins",
      actionUrl: payUrl,
      ctaHref: payUrl,
      summary,
      summaryText: summary,
      orderTotalText: summary,
    };
  }

  if (status === "partial") {
    const paid = data.paid_usd ?? data.paidUsd ?? "0.00";
    const remaining = data.remaining_usd ?? data.remainingUsd ?? total;
    const payUrl = data.pay_url ?? data.payUrl ?? "";
    const summary = `Paid: $${paid} USD · Remaining: $${remaining} USD`;
    return {
      render: true,
      visible: true,
      state: "partial",
      heading: "Partial payment received",
      text: `We received $${paid} of $${total}. Please send the remaining $${remaining} to complete your order.`,
      bodyText: `We received $${paid} of $${total}. Please send the remaining $${remaining} to complete your order.`,
      actionLabel: "Pay remaining balance",
      ctaLabel: "Pay remaining balance",
      actionUrl: payUrl,
      ctaHref: payUrl,
      summary,
      summaryText: summary,
      orderTotalText: `Total: $${total} USD`,
    };
  }

  if (status === "paid" || data.paid) {
    const paid = data.paid_usd ?? data.paidUsd ?? total;
    const tx = data.tx_hash ?? data.txHash ?? null;
    const txUrl = tx ? `${explorerBaseUrl.replace(/\/+$/, "")}/${tx}` : undefined;
    const summaryParts = [`Paid: $${paid} USD`];
    if (tx) summaryParts.unshift(`Transaction: ${tx}`);
    if (orderGidOrRef) summaryParts.push(`Order: ${orderGidOrRef}`);
    const details = summaryParts.join(" · ");
    const summary = data.summary ? `${data.summary} (${details})` : details;

    return {
      render: true,
      visible: true,
      state: "paid",
      heading: "Thank you, payment received",
      text: "Your payment was confirmed on NEAR.",
      bodyText: "Your payment was confirmed on NEAR.",
      summary,
      summaryText: summary,
      orderTotalText: `Total: $${total} USD`,
      txHash: tx,
      txUrl: txUrl ?? null,
      explorerUrl: txUrl,
    };
  }

  return {
    render: false,
    visible: false,
    state: "hidden",
    heading: "",
    text: "",
    bodyText: "",
  };
}
