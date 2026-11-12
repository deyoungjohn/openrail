/**
 * Pure selection and render model for the Openrail Checkout UI Extension.
 *
 * Verified against:
 * https://shopify.dev/docs/api/checkout-ui-extensions/latest/target-apis/checkout-apis/payments-api
 *
 * SelectedPaymentOption exposes `handle` and `type` only. Provider names, display names,
 * and logos are not available. To distinguish Openrail from other manual payment methods,
 * the merchant must configure `openrail_payment_handle`. If unset, the block does not render.
 */

export function shouldRenderCheckoutPay(
  selectedOptions?: Array<{ type?: string; handle?: string }>,
  configuredHandle?: string,
): boolean {
  const handle = (configuredHandle ?? "").trim();
  if (!handle) return false;
  return Array.isArray(selectedOptions) && selectedOptions.some((opt) => opt.handle === handle);
}
