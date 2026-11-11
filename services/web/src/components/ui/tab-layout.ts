/** The liquid surface keeps this inset on both sides of the panel (kept in step with `SURFACE_INSET` in morphing-tabs). */
export const TAB_SURFACE_INSET = 16;
/** The width of a tab before the panel has been measured. */
export const TAB_UNMEASURED_WIDTH = 176;

/**
 * The tab switches share the panel's width equally (human, 11 Nov): two tabs take half each, three a third each.
 * They fill the width between the insets, with no gaps.
 */
export function fillTabWidth(surfaceWidth: number, count: number): number {
  if (!surfaceWidth || count <= 0) return TAB_UNMEASURED_WIDTH;
  return (surfaceWidth - TAB_SURFACE_INSET * 2) / count;
}
