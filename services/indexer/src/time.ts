/** Normalize provider timestamps to Unix seconds in one place (NearBlocks uses ns). */
export function toSeconds(value: number | string | undefined | null): number {
  if (value === undefined || value === null || value === "") return 0;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
  }
  return Math.floor(numeric > 1_000_000_000_000 ? numeric / 1_000_000_000 : numeric);
}
