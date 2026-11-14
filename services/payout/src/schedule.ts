/** Payout schedule boundaries; weeks end Sunday and periods end at 00:00 UTC. */
export type PayoutScheduleMode = "manual" | "each_payment" | "daily" | "weekly" | "monthly";

export function calculatePeriodEndUtc(
  bookedAtUtc: number,
  schedule: PayoutScheduleMode,
): number | null {
  if (schedule === "manual") return null;
  if (schedule === "each_payment") return bookedAtUtc;
  const booked = new Date(bookedAtUtc);
  if (schedule === "daily")
    return Date.UTC(booked.getUTCFullYear(), booked.getUTCMonth(), booked.getUTCDate() + 1);
  if (schedule === "weekly") {
    const day = booked.getUTCDay();
    const days = day === 0 ? 1 : 8 - day;
    return Date.UTC(booked.getUTCFullYear(), booked.getUTCMonth(), booked.getUTCDate() + days);
  }
  if (schedule === "monthly") return Date.UTC(booked.getUTCFullYear(), booked.getUTCMonth() + 1, 1);
  throw new Error(`unknown payout schedule: ${String(schedule)}`);
}

export function isEligibleForPayout(
  bookedAtUtc: number,
  schedule: PayoutScheduleMode,
  nowUtc: number,
): boolean {
  const end = calculatePeriodEndUtc(bookedAtUtc, schedule);
  return end !== null && nowUtc >= end;
}
