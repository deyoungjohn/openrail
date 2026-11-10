/**
 * Shopify Checkout UI Extension for `purchase.thank-you.block.render`
 * and `customer-account.order-status.block.render`.
 *
 * Verified against:
 * - Targets: https://shopify.dev/docs/api/checkout-ui-extensions/2025-10/targets/block/purchase-thank-you-block-render
 * - Components (`Banner`, `BlockStack`, `Button`, `Text`):
 *   https://shopify.dev/docs/api/checkout-ui-extensions/2025-10/components
 */

export interface ThankYouBlockProps {
  orderTokenUrl: string;
  orderName: string;
  amountUsd: string;
  currencyCode: string;
  isPaid: boolean;
}

export interface ThankYouBlockRenderModel {
  visible: boolean;
  heading: string;
  bodyText: string;
  ctaLabel: string;
  ctaHref: string;
}

/**
 * Pure presentation model for the Thank-You & Order-Status Checkout UI Extension block.
 * Never passes an amount in the URL; the backend reads `totalOutstandingSet.shopMoney.amount`
 * from the Shopify Admin GraphQL API using the single-use `order_token`.
 */
export function buildThankYouBlockModel(props: ThankYouBlockProps): ThankYouBlockRenderModel {
  if (props.isPaid || props.currencyCode !== "USD") {
    return {
      visible: false,
      heading: "",
      bodyText: "",
      ctaLabel: "",
      ctaHref: "",
    };
  }

  return {
    visible: true,
    heading: `Pay Order ${props.orderName} with stablecoins`,
    bodyText: `Total due: $${props.amountUsd} USD. Pay with USDC, USDT, ETH, or SOL from any supported chain.`,
    ctaLabel: "Pay with stablecoins",
    ctaHref: props.orderTokenUrl,
  };
}
