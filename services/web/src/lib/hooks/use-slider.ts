"use client";

import { type KeyboardEvent, type PointerEvent, useCallback, useRef, useState } from "react";

export interface SliderOptions {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** The smallest move, by pointer and by the arrow keys. */
  step?: number;
  /** Values the thumb snaps to when it gets close (for example 25, 50, 75, 100). */
  snapPoints?: readonly number[];
  /** How close to a snap point, in value units, the thumb is pulled to it. */
  snapRadius?: number;
  disabled?: boolean;
  "aria-label"?: string;
  formatValueText?: (value: number) => string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The behaviour of a slider: pointer drag on the track, the keyboard on the thumb, snapping to chosen points. */
export function useSlider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  snapPoints = [],
  snapRadius = 2.5,
  disabled = false,
  "aria-label": ariaLabel,
  formatValueText,
}: SliderOptions) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const current = clamp(value, min, max);
  const percent = max === min ? 0 : ((current - min) / (max - min)) * 100;

  const settle = useCallback(
    (raw: number) => {
      const snapped = snapPoints.find((p) => Math.abs(raw - p) <= snapRadius);
      const next = snapped ?? Math.round(raw / step) * step;
      onChange(clamp(next, min, max));
    },
    [snapPoints, snapRadius, step, onChange, min, max],
  );

  const fromPointer = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      settle(min + clamp((clientX - r.left) / r.width, 0, 1) * (max - min));
    },
    [settle, min, max],
  );

  const trackProps = {
    ref: trackRef,
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      fromPointer(e.clientX);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (dragging) fromPointer(e.clientX);
    },
    onPointerUp: () => setDragging(false),
    onPointerCancel: () => setDragging(false),
  };

  const sliderProps = {
    role: "slider" as const,
    "aria-valuemin": min,
    "aria-valuemax": max,
    "aria-valuenow": current,
    "aria-valuetext": formatValueText ? formatValueText(current) : undefined,
    "aria-label": ariaLabel,
    "aria-disabled": disabled || undefined,
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      const keys: Record<string, number> = {
        ArrowRight: current + step,
        ArrowUp: current + step,
        ArrowLeft: current - step,
        ArrowDown: current - step,
        PageUp: current + 25,
        PageDown: current - 25,
        Home: min,
        End: max,
      };
      const next = keys[e.key];
      if (next === undefined) return;
      e.preventDefault();
      onChange(clamp(next, min, max));
    },
  };

  return { percent, current, dragging, trackProps, sliderProps };
}
