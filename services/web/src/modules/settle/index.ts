/** Settle module, web part. Loaded only when the module is enabled (generated `enabled.ts`). */
import { PayoutSettingsPanel, PayoutsPanel } from "./payouts-panel";

// The confidential balance is a tab of the Payout page (Public | Confidential); its two settings are also in Settings.
export const payoutSections = [{ id: "private", label: "Confidential", Panel: PayoutsPanel }];
export const settingsSections = [{ id: "payouts", label: "Payouts", Panel: PayoutSettingsPanel }];
