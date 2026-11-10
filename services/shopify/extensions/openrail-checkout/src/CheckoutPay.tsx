// The checkout page, before the order is placed. When the buyer picks the Openrail payment method this block shows
// the payment link. The link needs an invoice for the cart before any order exists: the connector route
// `GET /shopify/extension/checkout-pay-link` (session token, cart total and checkout token) is PENDING (prompts/ag6.md),
// so until it answers the block shows the "preparing" state and then the warning.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

const DEFAULT_BASE = "https://shopify.openrail.incepture.dev";

type Globals = {
  settings?: { value?: Record<string, unknown> };
  sessionToken: { get(): Promise<string> };
  selectedPaymentOptions?: { value?: Array<{ type?: string; handle?: string }> };
  checkoutToken?: { value?: string };
  cost?: { totalAmount?: { value?: { amount?: number; currencyCode?: string } } };
};

export default function extension() {
  render(<CheckoutPay />, document.body);
}

function CheckoutPay() {
  const g = shopify as unknown as Globals;
  const base = String(g.settings?.value?.openrail_app_base_url ?? DEFAULT_BASE).replace(/\/+$/, "");
  const checkout = g.checkoutToken?.value;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!checkout) return;
    let off = false;
    (async () => {
      try {
        const token = await g.sessionToken.get();
        const response = await fetch(`${base}/shopify/extension/checkout-pay-link?checkout=${encodeURIComponent(checkout)}`, {
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
  }, [base, checkout]);

  if (failed)
    return (
      <s-banner heading="Pay with stablecoins" tone="warning">
        <s-text>We could not prepare the payment link. Reload the page or choose another payment method.</s-text>
      </s-banner>
    );
  return (
    <s-banner heading="Pay with stablecoins (Openrail)">
      {url ? <s-button href={url}>Pay with stablecoins</s-button> : <s-text>Preparing your payment link…</s-text>}
    </s-banner>
  );
}
