"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  panel: ReactNode;
}

export function Tabs({
  items,
  label,
  value,
  onValueChange,
  fill,
}: {
  items: readonly TabItem[];
  label: string;
  value?: string;
  onValueChange?: (id: string) => void;
  /** Equal-width tabs whose long labels wrap, for a short screen (two tabs). */
  fill?: boolean;
}) {
  const base = useId();
  const [inner, setInner] = useState(items[0]?.id);
  const current = value ?? inner;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (id: string) => {
    setInner(id);
    onValueChange?.(id);
    refs.current[id]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const last = items.length - 1;
    const next =
      e.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : e.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    const target = items[next];
    if (target) select(target.id);
  };

  return (
    <div>
      <div
        role="tablist"
        aria-label={label}
        className={cn("border-b border-border", fill ? "grid" : "flex gap-6 overflow-x-auto")}
        style={
          fill ? { gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` } : undefined
        }
      >
        {items.map((t, i) => {
          const selected = t.id === current;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(t.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                "-mb-px inline-flex items-center gap-2 border-b-2 text-[14px] leading-5 font-medium",
                fill ? "min-h-11 justify-center px-2 py-2 text-center" : "h-11 whitespace-nowrap",
                "transition-colors duration-[var(--dur)] ease-[var(--ease)]",
                selected
                  ? "border-accent text-accent-text"
                  : "border-transparent text-muted hover:text-text",
              )}
            >
              {t.label}
              {t.count === undefined ? null : (
                <span className="tabular rounded-full bg-surface-2 px-2 text-[12px] leading-5 text-muted">
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {items.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={t.id !== current}
          className="pt-4"
        >
          {t.id === current ? t.panel : null}
        </div>
      ))}
    </div>
  );
}
