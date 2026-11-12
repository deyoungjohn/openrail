/** Settle module, web part. Loaded only when the module is enabled (generated `enabled.ts`). */
import { PayoutsPanel } from "./payouts-panel";

// The private balance is a tab of the Pay out page (Public | Private), not of Settings.
export const payoutSections = [{ id: "private", label: "Private", Panel: PayoutsPanel }];
