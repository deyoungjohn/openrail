"use client";
// Ported from the bubble range slider in the lab's UI/components (beui.dev/components/motion/range-slider), with
// this project's colours, snap marks and the hook in lib/hooks/use-slider.

import {
  AnimatePresence,
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  useVelocity,
} from "motion/react";
import { useEffect } from "react";
import { cn } from "@/lib/cn";
import { SPRING_GLIDE, SPRING_PANEL, SPRING_PRESS } from "@/lib/ease";
import { type SliderOptions, useSlider } from "@/lib/hooks/use-slider";
import { TOUCH_GESTURE_CLASS } from "@/lib/touch";

// Loose enough that the bubble keeps leaning a beat after the pointer stops.
const SPRING_TILT = { stiffness: 260, damping: 22, mass: 0.4 } as const;
/** Drag speed (px/s of track percent) that maxes out lean and squash. */
const FULL_TILT = 320;

export interface RangeSliderProps extends SliderOptions {
  /** Formats the value shown in the bubble. */
  format?: (value: number) => string;
  /** Labelled stops under the track (the thumb snaps to the values in `snapPoints`). */
  marks?: readonly { value: number; label: string }[];
  className?: string;
}

/**
 * A slider with a value bubble that pops out of the thumb on grab and leans with how fast you drag. The thumb snaps
 * to the marks when it comes close, so 25%, 50%, 75% and 100% are easy to hit exactly.
 */
export function RangeSlider({ format, marks, className, ...options }: RangeSliderProps) {
  const reduce = useReducedMotion();
  const { percent, current, dragging, trackProps, sliderProps } = useSlider({
    ...options,
    formatValueText: options.formatValueText ?? format,
  });
  const min = options.min ?? 0;
  const max = options.max ?? 100;
  const readout = format ? format(current) : current;

  const target = useMotionValue(percent);
  useEffect(() => {
    target.set(percent);
  }, [percent, target]);
  const smooth = useSpring(target, SPRING_GLIDE);
  const pos = reduce ? target : smooth;
  const left = useMotionTemplate`${pos}%`;

  const velocity = useVelocity(pos);
  const lean = useSpring(
    useTransform(velocity, [-FULL_TILT, 0, FULL_TILT], [1, 0, -1], { clamp: true }),
    SPRING_TILT,
  );
  const tilt = useTransform(lean, (v) => v * 16);
  const squash = useTransform(lean, (v) => 1 + Math.abs(v) * 0.18);
  const stretch = useTransform(lean, (v) => 1 - Math.abs(v) * 0.12);

  return (
    <div
      className={cn(
        // room for the thumb, the bubble and the 48px hit area to overhang the 8px track
        "relative w-full px-5",
        options.disabled ? "pointer-events-none opacity-50" : undefined,
        className,
      )}
    >
      <div className="relative h-14 pt-3">
        <div
          {...trackProps}
          className={cn(
            "relative h-2 w-full touch-none rounded-full bg-border",
            TOUCH_GESTURE_CLASS,
            options.disabled ? undefined : "cursor-grab active:cursor-grabbing",
          )}
        >
          <motion.div
            className="absolute inset-y-0 left-0 rounded-full bg-accent"
            style={{ width: left }}
          />

          {marks?.map((m) => {
            const at = max === min ? 0 : ((m.value - min) / (max - min)) * 100;
            return (
              <span
                key={m.value}
                aria-hidden
                className="pointer-events-none absolute top-full mt-2 -translate-x-1/2 text-[12px] leading-4 text-muted tabular-nums"
                style={{ left: `${at}%` }}
              >
                <span className="absolute -top-2 left-1/2 h-1.5 w-px -translate-x-1/2 bg-border" />
                {m.label}
              </span>
            );
          })}

          <motion.div
            className="absolute top-1/2 size-5 rounded-full border-2 border-accent bg-surface shadow-sm"
            style={{ left, x: "-50%", y: "-50%" }}
            animate={reduce ? undefined : { scale: dragging ? 1.25 : 1 }}
            transition={SPRING_PRESS}
          />

          <motion.div className="pointer-events-none absolute bottom-6" style={{ left, x: "-50%" }}>
            <AnimatePresence>
              {dragging ? (
                <motion.div
                  initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.4, y: 10 }}
                  animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
                  exit={
                    reduce
                      ? { opacity: 0, transition: { duration: 0.12 } }
                      : { opacity: 0, scale: 0.5, y: 8, transition: { duration: 0.12 } }
                  }
                  transition={reduce ? { duration: 0.12 } : SPRING_PANEL}
                  style={
                    reduce
                      ? undefined
                      : { rotate: tilt, scaleX: squash, scaleY: stretch, originY: 1 }
                  }
                  className="relative rounded-xl bg-text px-2.5 py-1 text-sm font-medium whitespace-nowrap text-bg tabular-nums shadow-md"
                >
                  {readout}
                  <span className="absolute -bottom-1 left-1/2 size-2.5 -translate-x-1/2 rotate-45 rounded-[3px] bg-text" />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </motion.div>

          {/* 8px of track is not a touch target: the hit area is 48px */}
          <button
            type="button"
            {...sliderProps}
            className="absolute inset-x-0 -inset-y-5 touch-none rounded-full ring-accent/40 outline-none focus-visible:ring-4"
          />
        </div>
      </div>
    </div>
  );
}
