// The thank-you page, after the order is placed. Thanks only, plus the order: no payment link here (that is the
// "Openrail Checkout" extension, shown before the order). Transaction hashes and an order summary come from the
// connector once it serves them (pending, see prompts/ag6.md).
import "@shopify/ui-extensions/preact";
import { render } from "preact";

export default function extension() {
  render(<ThankYou />, document.body);
}

function ThankYou() {
  const confirmation = (
    shopify as unknown as { orderConfirmation?: { value?: { number?: string } } }
  ).orderConfirmation;
  const number = confirmation?.value?.number;
  return (
    <s-banner heading="Thank you" tone="success">
      <s-text>{number ? `Your order ${number} is confirmed.` : "Your order is confirmed."}</s-text>
    </s-banner>
  );
}
