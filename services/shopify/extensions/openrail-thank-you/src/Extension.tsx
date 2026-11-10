// The thank-you page, after the order is placed. Thanks only, plus the order: no payment link here (that is the
// "Openrail Checkout" extension, shown before the order). Transaction hashes and an order summary come from the
// connector once it serves them (pending, see prompts/ag6.md).
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

const DEFAULT_BASE = "https://shopify.openrail.incepture.dev";

type Globals = {
  settings?: { value?: Record<string, unknown> };
  sessionToken?: { get(): Promise<string> };
  orderConfirmation?: { value?: { number?: string; order?: { id?: string } } };
  checkoutToken?: { value?: string };
};

export default function extension() {
  render(<ThankYou />, document.body);
}

function ThankYou() {
  const g = shopify as unknown as Globals;
  const base = String(g.settings?.value?.openrail_app_base_url ?? DEFAULT_BASE).replace(/\/+$/, "");
  const number = g.orderConfirmation?.value?.number;
  const orderGid = g.orderConfirmation?.value?.order?.id;
  const checkout = g.checkoutToken?.value;

  const [status, setStatus] = useState<{
    tx_hash?: string | null;
    summary?: string;
    status?: string;
  } | null>(null);

  useEffect(() => {
    if (!g.sessionToken || (!orderGid && !checkout)) return;
    let off = false;
    (async () => {
      try {
        const token = await g.sessionToken!.get();
        const params = new URLSearchParams();
        if (orderGid) params.set("order", orderGid);
        if (checkout) params.set("checkout", checkout);
        const res = await fetch(`${base}/shopify/extension/order-status?${params.toString()}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          tx_hash?: string | null;
          summary?: string;
          status?: string;
        };
        if (!off) setStatus(data);
      } catch {
        // Fallback gracefully to default confirmation banner
      }
    })();
    return () => {
      off = true;
    };
  }, [base, orderGid, checkout]);

  return (
    <s-banner heading="Thank you" tone="success">
      <s-text>{number ? `Your order ${number} is confirmed.` : "Your order is confirmed."}</s-text>
      {status?.tx_hash ? <s-text>{`Transaction: ${status.tx_hash}`}</s-text> : null}
      {status?.summary ? <s-text>{status.summary}</s-text> : null}
    </s-banner>
  );
}
