"use client";

import type { ReactNode } from "react";
import { MorphingTabs } from "./morphing-tabs";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  panel: ReactNode;
}

/**
 * Tabs on the morphing-tabs block (beui): the chosen tab grows into the panel under it. Tabs cannot be closed.
 * Keep labels short: a tab is at most 176 px wide and a longer label is cut with an ellipsis.
 */
export function Tabs({
  items,
  label,
  value,
  onValueChange,
}: {
  items: readonly TabItem[];
  label: string;
  value?: string;
  onValueChange?: (id: string) => void;
  /** Kept for the old API; the block sizes its tabs itself. */
  fill?: boolean;
}) {
  return (
    <MorphingTabs
      ariaLabel={label}
      {...(value === undefined ? {} : { value })}
      defaultValue={items[0]?.id ?? null}
      onValueChange={(id) => {
        if (id !== null) onValueChange?.(id);
      }}
      items={items.map((t) => ({
        id: t.id,
        label: t.count === undefined ? t.label : `${t.label} ${t.count}`,
        content: <div className="p-4 sm:p-6">{t.panel}</div>,
      }))}
      classNames={{ root: "bg-surface-2", content: "mb-4" }}
    />
  );
}
