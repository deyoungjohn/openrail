import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

const POSITION = {
  top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
  left: "right-full top-1/2 mr-1.5 -translate-y-1/2",
} as const;

/**
 * A name for an icon-only control, shown on hover and on keyboard focus. The control keeps its own
 * `aria-label` (that is its accessible name), so the bubble is for sighted people only. Inside a table
 * use `side="left"`: a bubble above the first row would be clipped by the table's scroll area.
 */
export function Tooltip({
  label,
  side = "top",
  className,
  children,
}: {
  label: ReactNode;
  side?: keyof typeof POSITION;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn("group/tip relative inline-flex", className)}>
      {children}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute z-40 max-w-[240px] rounded-md bg-text px-2 py-1 text-[12px] leading-4 font-medium whitespace-nowrap text-bg opacity-0 shadow-md",
          "transition-opacity duration-150 group-hover/tip:opacity-100 group-hover/tip:delay-300 group-has-[:focus-visible]/tip:opacity-100",
          "motion-reduce:transition-none print:hidden",
          POSITION[side],
        )}
      >
        {label}
      </span>
    </span>
  );
}
