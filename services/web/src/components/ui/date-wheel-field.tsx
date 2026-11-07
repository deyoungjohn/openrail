"use client";

import { CalendarDays } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { ErrorNote } from "./error-note";
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "./popover-morph";
import { WheelPicker } from "./wheel-picker";

const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 1),
  label: new Date(Date.UTC(2000, i, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" }),
}));

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");
const parts = (iso: string): [number, number, number] | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/**
 * Pick one day (not a range) on three wheels: month, day, year. The value is `YYYY-MM-DD`, empty until a day is
 * chosen. `min` is the earliest day offered (default tomorrow, UTC).
 */
export function DateWheelField({
  label,
  value,
  onChange,
  error,
  min,
  years = 6,
}: {
  label: string;
  value: string;
  onChange: (iso: string) => void;
  error?: string | undefined;
  min?: string;
  years?: number;
}) {
  const tomorrow = useMemo(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), []);
  const floor = parts(min ?? tomorrow) as [number, number, number];
  const [open, setOpen] = useState(false);
  const chosen = parts(value);
  // What the wheels show: the chosen day, or the earliest day offered while nothing is chosen.
  const [y, m, d] = chosen ?? floor;
  const yearOptions = Array.from({ length: years }, (_, i) => String(floor[0] + i));
  const dayOptions = Array.from({ length: daysIn(y, m) }, (_, i) => String(i + 1));

  const set = (next: { y?: number; m?: number; d?: number }) => {
    const ny = next.y ?? y;
    const nm = next.m ?? m;
    const nd = Math.min(next.d ?? d, daysIn(ny, nm));
    let iso = `${ny}-${pad(nm)}-${pad(nd)}`;
    const lowest = `${floor[0]}-${pad(floor[1])}-${pad(floor[2])}`;
    if (iso < lowest) iso = lowest;
    onChange(iso);
  };

  const shown = chosen
    ? new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "Pick a date";

  return (
    <div className="w-full">
      <div className="relative">
        <span className="pointer-events-none absolute top-0 left-3 z-10 -translate-y-1/2 bg-surface px-1 text-[12px] leading-5 font-medium text-muted dark:bg-surface-2">
          {label}
        </span>
        <MorphPopover open={open} onOpenChange={setOpen}>
          <MorphPopoverTrigger>
            <button
              type="button"
              aria-label={`${label}: ${shown}`}
              aria-invalid={error ? true : undefined}
              className={cn(
                "inline-flex h-11 w-full items-center gap-2 rounded-[10px] border bg-surface px-3 text-[15px] transition-colors hover:border-muted focus-visible:border-accent focus-visible:outline-none dark:bg-surface-2",
                error ? "border-danger" : "border-border",
                !chosen && "text-muted",
              )}
            >
              <CalendarDays aria-hidden size={16} className="shrink-0 text-muted" />
              <span className="tabular truncate">{shown}</span>
            </button>
          </MorphPopoverTrigger>
          <MorphPopoverContent
            align="start"
            radius={16}
            shadow={false}
            className="w-[19rem] max-w-[calc(100vw-1.5rem)]"
          >
            <div className="space-y-3 p-3">
              <div className="grid grid-cols-[1.6fr_1fr_1.1fr] gap-2">
                <WheelPicker
                  aria-label="Month"
                  options={MONTHS}
                  value={String(m)}
                  onValueChange={(v) => set({ m: Number(v) })}
                />
                <WheelPicker
                  aria-label="Day"
                  options={dayOptions}
                  value={String(d)}
                  onValueChange={(v) => set({ d: Number(v) })}
                />
                <WheelPicker
                  aria-label="Year"
                  options={yearOptions}
                  value={String(y)}
                  onValueChange={(v) => set({ y: Number(v) })}
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!chosen) set({});
                  setOpen(false);
                }}
                className="h-10 w-full rounded-[10px] bg-accent text-[14px] font-medium text-on-accent hover:bg-accent-hover"
              >
                Done
              </button>
            </div>
          </MorphPopoverContent>
        </MorphPopover>
      </div>
      <ErrorNote variant="field">{error ? error : null}</ErrorNote>
    </div>
  );
}
