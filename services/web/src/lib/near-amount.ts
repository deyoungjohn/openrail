// yoctoNEAR, exact. 1 NEAR = 10^24 yoctoNEAR.

const NEAR = 10n ** 24n;

/** About 0.02 NEAR of storage per invoice (blueprint 2.2: 1 NEAR is about 50 invoices). */
export const STORAGE_PER_INVOICE_YOCTO = NEAR / 50n;

/** yoctoNEAR as NEAR with every digit, trailing zeros trimmed: `0.02`, `5`, `1,234.5`. */
export function formatNear(yocto: bigint): string {
  const whole = (yocto / NEAR).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (yocto % NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac === "" ? whole : `${whole}.${frac}`;
}

/** True when the prepaid balance cannot cover one more invoice. */
export const storageCreditLow = (balanceYocto: bigint): boolean =>
  balanceYocto < STORAGE_PER_INVOICE_YOCTO;

/** The smallest storage-credit deposit offered: one invoice's worth, 0.02 NEAR. */
export const MIN_DEPOSIT_YOCTO = STORAGE_PER_INVOICE_YOCTO;

/**
 * NEAR typed by a person (`0.5`, `2`, `.02`, with an optional `,`) as exact yoctoNEAR. `null` for anything that is
 * not a plain positive decimal with at most 24 places, so a typo never becomes an amount.
 */
export function parseNear(text: string): bigint | null {
  const t = text.trim().replace(/,/g, "");
  const m = /^(\d*)(?:\.(\d{1,24}))?$/.exec(t);
  if (!m || (m[1] === "" && m[2] === undefined)) return null;
  const whole = BigInt(m[1] === "" ? "0" : (m[1] as string));
  const frac = BigInt((m[2] ?? "").padEnd(24, "0") || "0");
  return whole * NEAR + frac;
}
