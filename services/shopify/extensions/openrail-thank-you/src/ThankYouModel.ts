/**
 * Pure presentation model for the Thank-You Checkout UI Extension block.
 *
 * Requirements from prompts/ag6.md (Updates 15 & 17):
 * The block shows:
 * 1. unpaid: "Order placed" heading, one sentence, a "Pay with stablecoins" button to the pay link, the order total.
 * 2. partial: "Partial payment received", amount paid, amount still due, "Pay remaining balance" button.
 * 3. paid: "Thank you, payment received", "Your payment was confirmed on NEAR.", booking transaction hash(es) as links, summary.
 * 4. error: "Payment status unavailable", "We could not load the payment status for this order. Reload the page, or contact the shop.", tone: warning, no other controls.
 *
 * Never says thanks before money is booked.
 * Only a 404 with code not_openrail_order or order_not_found renders nothing (render = false / visible = false).
 * All other failures render the error banner.
 * While polling, transient failures retain the last good state until 3 failures in a row.
 */

export interface ThankYouData {
  status?: "unpaid" | "partial" | "paid" | "error" | "hidden" | string;
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
  state: "unpaid" | "partial" | "paid" | "error" | "hidden";
  tone?: "warning" | "success" | "info" | "critical";
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

  const status = data.status;

  if (status === "error") {
    return {
      render: true,
      visible: true,
      state: "error",
      tone: "warning",
      heading: "Payment status unavailable",
      text: "We could not load the payment status for this order. Reload the page, or contact the shop.",
      bodyText: "We could not load the payment status for this order. Reload the page, or contact the shop.",
    };
  }

  if (status === "order_pending") {
    return {
      render: true,
      visible: true,
      state: "unpaid",
      heading: "Order placed",
      text: "Preparing your payment link…",
      bodyText: "Preparing your payment link…",
      summary: "Preparing your payment link…",
      summaryText: "Preparing your payment link…",
    };
  }

  const total = data.total_usd ?? data.totalUsd ?? "0.00";

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
      tone: "success",
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

export type OrderStatusResult =
  | { kind: "ok"; data: ThankYouData }
  | { kind: "not_openrail" }
  | { kind: "failure"; status: number | string };

export async function parseOrderStatusResponse(
  res: { status: number; ok: boolean; json?: () => Promise<unknown> } | null | undefined,
): Promise<OrderStatusResult> {
  if (!res) {
    return { kind: "failure", status: "network_error" };
  }

  if (res.status === 404) {
    try {
      const json = res.json ? ((await res.json()) as Record<string, unknown>) : null;
      const err = json?.error ?? json?.code;
      if (err === "not_openrail_order" || err === "order_not_found") {
        return { kind: "not_openrail" };
      }
    } catch {
      // 404 response body was not valid JSON
    }
    return { kind: "failure", status: 404 };
  }

  if (res.status === 202) {
    try {
      const json = res.json ? ((await res.json()) as Record<string, unknown>) : null;
      if (json && typeof json === "object") {
        return {
          kind: "ok",
          data: {
            status: "order_pending",
            summary: (json.summary as string) ?? "Preparing your payment link…",
          },
        };
      }
    } catch {
      // ignore
    }
    return {
      kind: "ok",
      data: {
        status: "order_pending",
        summary: "Preparing your payment link…",
      },
    };
  }

  if (!res.ok) {
    return { kind: "failure", status: res.status };
  }

  try {
    const json = res.json ? ((await res.json()) as Record<string, unknown>) : null;
    if (!json || typeof json !== "object") {
      return { kind: "failure", status: "unparsable_body" };
    }
    const parsed: ThankYouData = {
      status: (json.status as "unpaid" | "partial" | "paid") ?? "unpaid",
      totalUsd: (json.total_usd as string) ?? (json.amount_usd as string) ?? "0.00",
      paidUsd: json.paid_usd as string | undefined,
      remainingUsd: json.remaining_usd as string | undefined,
      payUrl: json.pay_url as string | undefined,
      txHash: json.tx_hash as string | null | undefined,
      summary: json.summary as string | undefined,
    };
    return { kind: "ok", data: parsed };
  } catch {
    return { kind: "failure", status: "unparsable_body" };
  }
}

export interface PollFailureState {
  lastGoodData: ThankYouData | null;
  consecutiveFailures: number;
}

export interface PollTransition {
  nextData: ThankYouData | null;
  nextState: PollFailureState;
  shouldWarn: boolean;
  warnStatus?: number | string;
}

export function stepPollState(
  current: PollFailureState,
  result: OrderStatusResult,
): PollTransition {
  if (result.kind === "not_openrail") {
    return {
      nextData: null,
      nextState: {
        lastGoodData: null,
        consecutiveFailures: 0,
      },
      shouldWarn: false,
    };
  }

  if (result.kind === "ok") {
    return {
      nextData: result.data,
      nextState: {
        lastGoodData: result.data,
        consecutiveFailures: 0,
      },
      shouldWarn: false,
    };
  }

  const nextFailures = current.consecutiveFailures + 1;
  const shouldShowError = current.lastGoodData === null || nextFailures >= 3;
  const nextData: ThankYouData = shouldShowError
    ? { status: "error" }
    : current.lastGoodData!;

  return {
    nextData,
    nextState: {
      lastGoodData: current.lastGoodData,
      consecutiveFailures: nextFailures,
    },
    shouldWarn: true,
    warnStatus: result.status,
  };
}
