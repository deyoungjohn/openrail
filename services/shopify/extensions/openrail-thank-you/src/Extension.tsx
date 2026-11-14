import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  buildThankYouViewModel,
  parseOrderStatusResponse,
  stepPollState,
  type OrderStatusResult,
  type PollFailureState,
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
  const orderGid = g.orderConfirmation?.value?.order?.id ?? g.orderConfirmation?.current?.order?.id;
  const confirmationNumber =
    g.orderConfirmation?.value?.number ?? g.orderConfirmation?.current?.number;
  const [data, setData] = useState<ThankYouData | null>(null);

  useEffect(() => {
    let unmounted = false;
    let pollCount = 0;
    const maxPolls = 180; // 15 minutes at 5s interval
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let pollState: PollFailureState = {
      lastGoodData: null,
      consecutiveFailures: 0,
    };

    const applyResult = (res: OrderStatusResult): ThankYouData | null => {
      const transition = stepPollState(pollState, res);
      pollState = transition.nextState;
      if (transition.shouldWarn) {
        console.warn("[openrail] order-status failed", transition.warnStatus);
      }
      if (!unmounted) {
        setData(transition.nextData);
      }
      return transition.nextData;
    };

    const fetchStatus = async (): Promise<ThankYouData | null> => {
      if (!g.sessionToken) {
        return applyResult({ kind: "failure", status: "no_token" });
      }
      if (!orderGid) {
        return applyResult({ kind: "failure", status: "missing_order" });
      }

      try {
        const token = await g.sessionToken.get();
        if (!token) {
          return applyResult({ kind: "failure", status: "no_token" });
        }
        const confParam = confirmationNumber
          ? `&confirmation=${encodeURIComponent(confirmationNumber)}`
          : "";
        const res = await fetch(
          `${base}/shopify/extension/order-status?order=${encodeURIComponent(orderGid)}${confParam}`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        const parsedResult = await parseOrderStatusResponse(res);
        return applyResult(parsedResult);
      } catch {
        return applyResult({ kind: "failure", status: "network_error" });
      }
    };

    void fetchStatus().then((initial) => {
      if (unmounted) return;
      if (initial && initial.status !== "paid" && initial.status !== "hidden") {
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
  }, [base, orderGid, confirmationNumber]);

  const vm = buildThankYouViewModel(data);
  if (!vm.visible) return null;

  if (vm.state === "error") {
    return (
      <s-banner heading={vm.heading} tone="warning">
        <s-text>{vm.bodyText}</s-text>
      </s-banner>
    );
  }

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
