import type { FetchLike } from "./chain.js";

export interface LowBalanceAlert {
  service: "watcher";
  kind: "low_balance";
  account: string;
  balance_near: number;
  threshold_near: number;
  at: string;
}

export type AlertSink = (alert: LowBalanceAlert) => Promise<void>;

/** Posts the alert as JSON. A missing webhook URL makes alerts a no-op. */
export function webhookAlertSink(
  url: string | undefined,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): AlertSink {
  if (url === undefined || url.trim() === "") {
    return async () => {};
  }
  return async (alert) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`ALERT_WEBHOOK_HTTP_${response.status}`);
    }
  };
}
