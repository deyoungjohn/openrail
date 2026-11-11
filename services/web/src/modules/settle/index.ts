/** Settle module, web part. Loaded only when the module is enabled (generated `enabled.ts`). */
import { PayoutsPanel } from "./payouts-panel";

export const settingsSections = [{ id: "payouts", label: "Payouts", Panel: PayoutsPanel }];
