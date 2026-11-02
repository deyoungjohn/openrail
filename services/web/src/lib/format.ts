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
