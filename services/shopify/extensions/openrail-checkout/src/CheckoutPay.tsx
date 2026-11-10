// The checkout page, before the order is placed. When the buyer picks the Openrail payment method this block shows
// the payment link. The link needs an invoice for the cart before any order exists: the connector route
// `GET /shopify/extension/checkout-pay-link` (session token, cart total and checkout token) is PENDING (prompts/ag6.md),
// so until it answers the block shows the "preparing" state and then the warning.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { shouldRenderCheckoutPay } from "./CheckoutPayModel.js";

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
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // Per official Shopify documentation (https://shopify.dev/docs/api/checkout-ui-extensions/latest/target-apis/checkout-apis/payments-api):
  // SelectedPaymentOption exposes `handle` and `type` only. Provider names, display names, logos, fees, and installment
  // terms are NOT available.
  // Therefore, to prevent matching all manual payment methods (e.g. cash on delivery, bank transfer),
  // the merchant must configure `openrail_payment_handle` in the extension settings. If unset, the block does not render.
  const selectedOptions = g.selectedPaymentOptions?.value;
  const configuredHandle = String(g.settings?.value?.openrail_payment_handle ?? "").trim();
  const isSelected = shouldRenderCheckoutPay(selectedOptions, configuredHandle);

  const cost = g.cost?.totalAmount?.value;
  const amount = cost?.amount;
  const currency = cost?.currencyCode;

  useEffect(() => {
    if (!isSelected || !checkout || amount === undefined || Number(amount) <= 0) return;
    let off = false;
    (async () => {
      try {
        const token = await g.sessionToken.get();
        const amountQuery = `&amount=${encodeURIComponent(String(amount))}`;
        const currencyQuery = currency ? `&currency=${encodeURIComponent(currency)}` : "";
        const response = await fetch(
          `${base}/shopify/extension/checkout-pay-link?checkout=${encodeURIComponent(checkout)}${amountQuery}${currencyQuery}`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        if (!response.ok) {
          let code = `http_${response.status}`;
          try {
            const errBody = (await response.json()) as { error?: { code?: string } };
            if (errBody.error?.code) code = errBody.error.code;
          } catch {
            // ignore non-json errors
          }
          if (!off) {
            setErrorCode(code);
            setFailed(true);
          }
          return;
        }
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
  }, [base, checkout, isSelected, amount, currency]);

  if (!isSelected) {
    return null;
  }

  if (failed) {
    let errorText = "We could not prepare the payment link. Reload the page or choose another payment method.";
    if (errorCode === "rate_limited") {
      errorText = "Too many payment requests. Please wait a moment and try again.";
    } else if (errorCode === "unsupported_currency") {
      errorText = "Openrail payments only support USD currency at this time.";
    }
    return (
      <s-banner heading="Pay with stablecoins" tone="warning">
        <s-text>{errorText}</s-text>
      </s-banner>
    );
  }
  return (
    <s-banner heading="Pay with stablecoins (Openrail)">
      {url ? <s-button href={url}>Pay with stablecoins</s-button> : <s-text>Preparing your payment link…</s-text>}
    </s-banner>
  );
}
