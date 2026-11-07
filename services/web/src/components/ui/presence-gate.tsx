"use client";

import { usePresence } from "motion/react";
import type { ReactNode } from "react";

export interface PresenceGateRenderProps {
  /** False from the moment the item starts to leave. */
  isPresent: boolean;
  /** Spread onto the control: an element that is leaving takes no clicks and no focus. */
  gate: { inert?: boolean; tabIndex?: number; "aria-hidden"?: boolean };
}

/** Releases a control the moment its exit animation starts, so a fading item cannot be clicked or focused. */
export function PresenceGate({
  children,
}: {
  children: (props: PresenceGateRenderProps) => ReactNode;
}) {
  const [present] = usePresence();
  return (
    <>
      {children({
        isPresent: present,
        gate: present ? {} : { inert: true, tabIndex: -1, "aria-hidden": true },
      })}
    </>
  );
}
