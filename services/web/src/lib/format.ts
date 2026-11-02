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

/** USDC base units (6 decimals) as dollars. Whole cents read as `$1,234.56`; sub-cent amounts keep all 6 decimals, never rounded. */
export function formatUsdc(units: bigint): string {
  if (units % 10_000n === 0n) return formatUsd(units / 10_000n);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = (abs / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${negative ? "-" : ""}$${whole}.${frac}`;
}

const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/** Unix seconds as `Jan 16, 2027`, always in UTC so every viewer reads the same due date. */
export const formatDate = (unixSec: number): string => DATE.format(new Date(unixSec * 1000));
