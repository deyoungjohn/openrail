import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/CheckoutPay.tsx' {
  const shopify: import('@shopify/ui-extensions/purchase.checkout.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
