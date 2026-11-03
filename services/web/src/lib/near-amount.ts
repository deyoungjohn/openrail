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
