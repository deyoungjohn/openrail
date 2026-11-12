"use client";

import { DateRangePickerDropdown, type DateRange, type DateRangePreset } from "./date-range-picker";

export type { DateRange };

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Quick choices (UTC days ending today): the last 7, 30 and 90 days and this month. */
export function rangePresets(now: Date = new Date()): DateRangePreset[] {
  const end = iso(now);
  const back = (days: number) => iso(new Date(now.getTime() - (days - 1) * 86_400_000));
  return [
    { label: "Last 7 days", value: { from: back(7), to: end } },
    { label: "Last 30 days", value: { from: back(30), to: end } },
    { label: "Last 90 days", value: { from: back(90), to: end } },
    { label: "This month", value: { from: `${end.slice(0, 8)}01`, to: end } },
  ];
}

/** A button that opens a calendar for a range of days. `null` is "no range" (all time). */
export function DateRangeField({
  label,
  value,
  onChange,
  placeholder = "All time",
  presets,
  max,
  triggerClassName,
  className,
}: {
  label: string;
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
  placeholder?: string;
  presets?: DateRangePreset[];
  max?: string;
  /** Classes for the button, e.g. a fixed width so the label never resizes it. */
  triggerClassName?: string;
  /** Classes of the field's root (a full-width field in a form). */
  className?: string;
}) {
  return (
    <DateRangePickerDropdown
      label={label}
      value={value}
      onValueChange={onChange}
      presets={presets ?? rangePresets()}
      placeholder={placeholder}
      closeOnSelect
      {...(className === undefined ? {} : { className })}
      {...(triggerClassName === undefined ? {} : { triggerClassName })}
      {...(max === undefined ? {} : { max })}
    />
  );
}
