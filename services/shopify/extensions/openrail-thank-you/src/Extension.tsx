import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  buildThankYouViewModel,
  type ThankYouData,
} from "./ThankYouModel.js";

const DEFAULT_BASE = "https://shopify.openrail.incepture.dev";

type Globals = {
  settings?: { value?: Record<string, unknown> };
  sessionToken?: { get(): Promise<string> };
  orderConfirmation?: {
    value?: { number?: string; order?: { id?: string } };
    current?: { number?: string; order?: { id?: string } };
  };
};

export default function extension() {
  render(<ThankYou />, document.body);
}

function ThankYou() {
  const g = shopify as unknown as Globals;
  const base = String(g.settings?.value?.openrail_app_base_url ?? DEFAULT_BASE).replace(/\/+$/, "");
  const orderGid =
    g.orderConfirmation?.value?.order?.id ?? g.orderConfirmation?.current?.order?.id;
  const [data, setData] = useState<ThankYouData | null>(null);

  useEffect(() => {
    if (!g.sessionToken || !orderGid) return;
    let unmounted = false;
    let pollCount = 0;
    const maxPolls = 180; // 15 minutes at 5s interval
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const fetchStatus = async () => {
      try {
        const token = await g.sessionToken!.get();
        const res = await fetch(
          `${base}/shopify/extension/order-status?order=${encodeURIComponent(orderGid)}`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        if (res.status === 404) {
          if (!unmounted) setData(null);
          return null;
        }
        if (!res.ok) return null;
        const json = (await res.json()) as {
          status?: "unpaid" | "partial" | "paid";
          total_usd?: string;
          amount_usd?: string;
          paid_usd?: string;
          remaining_usd?: string;
          pay_url?: string;
          tx_hash?: string | null;
          summary?: string;
        };
        const parsed: ThankYouData = {
          status: json.status ?? "unpaid",
          totalUsd: json.total_usd ?? json.amount_usd ?? "0.00",
          paidUsd: json.paid_usd,
          remainingUsd: json.remaining_usd,
          payUrl: json.pay_url,
          txHash: json.tx_hash,
          summary: json.summary,
        };
        if (!unmounted) {
          setData(parsed);
        }
        return parsed;
      } catch {
        return null;
      }
    };

    void fetchStatus().then((initial) => {
      if (unmounted) return;
      if (initial && initial.status !== "paid") {
        intervalId = setInterval(async () => {
          if (unmounted) {
            if (intervalId) clearInterval(intervalId);
            return;
          }
          pollCount += 1;
          if (pollCount >= maxPolls || (typeof document !== "undefined" && document.hidden)) {
            if (pollCount >= maxPolls && intervalId) {
              clearInterval(intervalId);
            }
            return;
          }
          const updated = await fetchStatus();
          if (updated && updated.status === "paid" && intervalId) {
            clearInterval(intervalId);
          }
        }, 5000);
      }
    });

    return () => {
      unmounted = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [base, orderGid]);

  const vm = buildThankYouViewModel(data);
  if (!vm.visible) return null;

  if (data?.status === "paid") {
    return (
      <s-banner heading={vm.heading} tone="success">
        <s-text>{vm.bodyText}</s-text>
        {vm.txUrl ? (
          <s-link href={vm.txUrl}>{`Transaction: ${vm.txHash}`}</s-link>
        ) : vm.txHash ? (
          <s-text>{`Transaction: ${vm.txHash}`}</s-text>
        ) : null}
      </s-banner>
    );
  }

  return (
    <s-banner heading={vm.heading}>
      <s-text>{vm.bodyText}</s-text>
      {vm.orderTotalText ? <s-text>{vm.orderTotalText}</s-text> : null}
      {vm.ctaHref ? <s-button href={vm.ctaHref}>{vm.ctaLabel}</s-button> : null}
    </s-banner>
  );
}
