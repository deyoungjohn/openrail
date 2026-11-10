// TEMPORARY PROBE (orchestrator, 10 Nov): not committed. Draws a banner that says the block ran and what it found.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default function extension() {
  render(<Probe />, document.body);
}

function Probe() {
  const g = shopify as unknown as {
    orderConfirmation?: { value?: { order?: { id?: string } } };
    sessionToken: { get(): Promise<string> };
    settings?: { value?: Record<string, unknown> };
  };
  const orderId = g.orderConfirmation?.value?.order?.id;
  const base = String(g.settings?.value?.openrail_app_base_url ?? "https://shopify.openrail.incepture.dev").replace(/\/+$/, "");
  const [line, setLine] = useState("starting");
  useEffect(() => {
    (async () => {
      try {
        const token = await g.sessionToken.get();
        const r = await fetch(`${base}/shopify/extension/order-status?order=${encodeURIComponent(orderId ?? "")}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        let why = "";
        try {
          const b = (await r.json()) as { error?: { message?: string } };
          why = b?.error?.message ?? "";
        } catch {
          why = "";
        }
        setLine(`token ok, order-status HTTP ${r.status} ${why}`);
      } catch (e) {
        setLine(`fetch failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
      }
    })();
  }, []);
  return (
    <s-banner heading="Openrail block loaded" tone="info">
      <s-text>{`order id: ${orderId ?? "none"}; ${line}`}</s-text>
    </s-banner>
  );
}
