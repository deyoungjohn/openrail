// The checkout block itself (Shopify checkout UI extension, api_version 2025-10, Preact and Polaris web components).
// It asks the Openrail connector for the pay link of this order with the buyer's session token, and shows a button.
// The pure part (what to show) stays in ThankYouBlock.tsx, which the tests cover.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

const DEFAULT_BASE = "https://shopify.openrail.incepture.dev";

export default function extension() {
  render(<PayWithStablecoins />, document.body);
}

function PayWithStablecoins() {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Shopify's globals: the merchant's setting, and the order id the thank-you page already has.
  const settings = (shopify as unknown as { settings?: { value?: Record<string, unknown> } }).settings;
  const base = String(settings?.value?.openrail_app_base_url ?? DEFAULT_BASE).replace(/\/+$/, "");
  const confirmation = (
    shopify as unknown as { orderConfirmation?: { value?: { order?: { id?: string } } } }
  ).orderConfirmation;
  const orderId = confirmation?.value?.order?.id;

  useEffect(() => {
    if (!orderId) return;
    let off = false;
    (async () => {
      try {
        // A session token lives five minutes: ask for it just before the call.
        const token = await (
          shopify as unknown as { sessionToken: { get(): Promise<string> } }
        ).sessionToken.get();
        const response = await fetch(`${base}/shopify/extension/pay-link?order=${encodeURIComponent(orderId)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { pay_url?: string };
        if (!off && typeof body.pay_url === "string") setUrl(body.pay_url);
        else if (!off) setFailed(true);
      } catch {
        if (!off) setFailed(true);
      }
    })();
    return () => {
      off = true;
    };
  }, [base, orderId]);

  if (!orderId) return null;
  if (failed)
    return (
      <s-banner heading="Pay with stablecoins" tone="warning">
        <s-text>We could not load the payment link. Reload this page, or contact the shop.</s-text>
      </s-banner>
    );
  return (
    <s-banner heading="Pay with stablecoins">
      <s-text>Pay with USDC, USDT, ETH or SOL from any supported chain.</s-text>
      {url ? <s-button href={url}>Pay with stablecoins</s-button> : <s-text>Preparing your payment link…</s-text>}
    </s-banner>
  );
}
