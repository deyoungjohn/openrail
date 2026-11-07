/** Normalize provider timestamps to Unix seconds in one place (NearBlocks uses ns). */
export function toSeconds(value: number | string | undefined | null): number {
  if (value === undefined || value === null || value === "") return 0;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
  }
  // Nanoseconds are about 1.8e18 today, milliseconds 1.8e12, seconds 1.8e9. The old rule (anything above
  // 1e12 is nanoseconds) read every millisecond value as nanoseconds and stored 1970 (seen on 6 Nov).
  if (numeric > 1e17) return Math.floor(numeric / 1_000_000_000);
  if (numeric > 1e11) return Math.floor(numeric / 1000);
  return Math.floor(numeric);
}
