/** Easing and spring constants shared by the motion components (pagination, countdown, tables). */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
export const SPRING_LAYOUT = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;
export const SPRING_PRESS = { type: "spring", stiffness: 600, damping: 32 } as const;
