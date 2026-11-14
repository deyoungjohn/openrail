import "@shopify/ui-extensions";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
//@ts-ignore
declare module "./src/Extension.tsx" {
  const shopify: import("@shopify/ui-extensions/purchase.thank-you.block.render").Api;
  // eslint-disable-next-line no-shadow-restricted-names
  const globalThis: { shopify: typeof shopify };
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
//@ts-ignore
declare module "./src/ThankYouModel.ts" {
  const shopify: import("@shopify/ui-extensions/purchase.thank-you.block.render").Api;
  // eslint-disable-next-line no-shadow-restricted-names
  const globalThis: { shopify: typeof shopify };
}
