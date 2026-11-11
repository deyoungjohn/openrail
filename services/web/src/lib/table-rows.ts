/** The most rows any table shows at once (human rule, 11 Nov). More than this always paginates. */
export const MAX_TABLE_ROWS = 10;

/** The page size a table really uses: what it asked for, never below 1 and never above the hard maximum. */
export function clampPageSize(asked: number | undefined): number {
  const n = asked === undefined || !Number.isFinite(asked) ? MAX_TABLE_ROWS : Math.floor(asked);
  return Math.max(1, Math.min(n, MAX_TABLE_ROWS));
}
