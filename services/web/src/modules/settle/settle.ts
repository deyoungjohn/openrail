/** Settle module, web part: the pure parts of the payout settings (no React, no network). */
import type { PayoutSchedule } from "@openrail/api-client";

export const SCHEDULES: readonly { id: PayoutSchedule; label: string; hint: string }[] = [
  { id: "manual", label: "Manual", hint: "Nothing is sent. You cash out yourself." },
  {
    id: "each_payment",
    label: "After each payment",
    hint: "Each held payment is sent on within a minute or so.",
  },
  { id: "daily", label: "Daily", hint: "Held payments are sent once a day." },
  { id: "weekly", label: "Weekly", hint: "Held payments are sent once a week." },
  { id: "monthly", label: "Monthly", hint: "Held payments are sent once a month." },
];

/** Payments below this are not held ($1 in USDC units). */
export const PRIVATE_MIN_AMOUNT = "1000000";

export interface Settlement {
  chain: string;
  address: string;
  min_amount: string;
}

/** The private balance is on when the destination is the caller's own account on the `confidential` chain. */
export function privateBalanceOn(settlement: Settlement | null, accountId: string): boolean {
  return settlement?.chain === "confidential" && settlement.address === accountId;
}

export const setPrivateCall = (root: string, accountId: string) => ({
  receiverId: root,
  methodName: "set_settlement",
  args: { chain: "confidential", address: accountId, min_amount: PRIVATE_MIN_AMOUNT },
  gas: "30000000000000",
  deposit: "0",
});

export const clearSettlementCall = (root: string) => ({
  receiverId: root,
  methodName: "clear_settlement",
  args: {},
  gas: "30000000000000",
  deposit: "0",
});
