/** Motion constants shared by animated components (the countdown wheels, for now). */
export const motionTokens = {
  spring: {
    smooth: { type: "spring", stiffness: 170, damping: 26 },
    snappy: { type: "spring", stiffness: 420, damping: 34 },
    morph: { type: "spring", stiffness: 260, damping: 28 },
  },
  stagger: { item: 0.04 },
  duration: { fast: 0.15 },
  blur: { subtle: 3, soft: 6 },
} as const;
