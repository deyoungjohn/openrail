/** Checkout module, API part. Loaded only when the module is enabled (generated `enabled.ts`). */
import type { ApiModule } from "../../modules.js";
import { issuerCheckoutPort } from "./checkout-port.js";
import { Checkouts, type CheckoutOptions } from "./checkouts.js";
import { PaymentLinks, type PaymentLinkOptions } from "./payment-links.js";

export type CheckoutModuleOptions = Partial<PaymentLinkOptions> & CheckoutOptions;

export const CHECKOUT_EVENT_TYPES = [
  "checkout.created",
  "checkout.paid",
  "checkout.partial",
  "checkout.paid_late",
  "checkout.accepted",
  "checkout.refund_started",
] as const;

export function createCheckoutApiModule(options: CheckoutModuleOptions = {}): ApiModule {
  const port = options.checkouts ?? issuerCheckoutPort;
  const checkouts = new Checkouts({ ...options, checkouts: port });
  const links = new PaymentLinks({ ...options, checkouts: port });
  return {
    id: "checkout",
    eventTypes: [...CHECKOUT_EVENT_TYPES],
    route: async (request, context) =>
      (await checkouts.route(request, context)) ?? (await links.route(request, context)),
    quoteWindow: (tokenId, context) => checkouts.quoteWindow(tokenId, context),
    events: (event, context) => [
      ...checkouts.events(event, context),
      ...links.events(event, context),
    ],
  };
}

export const apiModule: ApiModule = createCheckoutApiModule();
