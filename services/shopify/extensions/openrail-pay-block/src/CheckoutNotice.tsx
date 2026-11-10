// A short notice during checkout (before the buyer has bought anything): it says how paying with stablecoins works, so
// nobody is surprised that the payment link comes after the order is placed. It says nothing about thanks: that is
// the other block (Extension.tsx), which belongs to the page shown after the purchase.
import "@shopify/ui-extensions/preact";
import { render } from "preact";

export default function extension() {
  render(<Notice />, document.body);
}

function Notice() {
  return (
    <s-banner heading="Pay with stablecoins">
      <s-text>
        Choose "Pay with stablecoins (Openrail)" as your payment method. You get the payment link on the page that
        follows once you place the order.
      </s-text>
    </s-banner>
  );
}
