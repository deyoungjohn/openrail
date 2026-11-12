/** Settle module, web part. Loaded only when the module is enabled (generated `enabled.ts`). */
import { PayoutSettingsPanel, PayoutsPanel } from "./payouts-panel";

// The private balance is a tab of the Pay out page (Public | Private); its two settings are also in Settings.
export const payoutSections = [{ id: "private", label: "Private", Panel: PayoutsPanel }];
export const settingsSections = [{ id: "payouts", label: "Payouts", Panel: PayoutSettingsPanel }];
