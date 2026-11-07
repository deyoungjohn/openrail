/** Checkout module, web part. Loaded only when the module is enabled (generated `enabled.ts`). */
import { CheckoutScreen } from "./checkout-screen";
import { resolveClaimKind } from "./claim-kind";

export const PublicOrderPage = CheckoutScreen;
export { CheckoutScreen, resolveClaimKind };
