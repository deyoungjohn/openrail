/** Checkout module, API part. Loaded only when the module is enabled (generated `enabled.ts`). */
import type { ApiModule } from "../../modules.js";
import { issuerCheckoutPort } from "./checkout-port.js";
import { PaymentLinks, type PaymentLinkOptions } from "./payment-links.js";

export function createCheckoutApiModule(options: Partial<PaymentLinkOptions> = {}): ApiModule {
  const links = new PaymentLinks({ checkouts: issuerCheckoutPort, ...options });
  return {
    id: "checkout",
    route: (request, context) => links.route(request, context),
    events: (event, context) => links.events(event, context),
  };
}

export const apiModule: ApiModule = createCheckoutApiModule();
