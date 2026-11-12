/** Splits a USD amount in cents into display parts. Never rounds money. */
export function usdParts(cents: bigint): { whole: string; cents: string } {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return { whole: `${negative ? "-" : ""}$${whole}`, cents: frac };
}

export const formatUsd = (cents: bigint): string => {
  const p = usdParts(cents);
  return `${p.whole}.${p.cents}`;
};

/** 0x1bfc...a603 */
export function middleTruncate(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** USDC base units (6 decimals) as dollars and cents, rounded half up (two decimals everywhere: the human's hard rule). For what a person signs and for claim counters. */
export function formatUsdcExact(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const cents = (abs + 5_000n) / 10_000n;
  return negative ? `-${formatUsd(cents)}` : formatUsd(cents);
}

/** USDC base units as dollars and cents, a sub-cent amount rounded up to the next cent. For summaries. */
export function formatUsdc(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const cents = (abs + 9_999n) / 10_000n;
  return negative ? `-${formatUsd(cents)}` : formatUsd(cents);
}

const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/** Unix seconds as `Jan 16, 2027`, always in UTC so every viewer reads the same due date. */
export const formatDate = (unixSec: number): string => DATE.format(new Date(unixSec * 1000));
