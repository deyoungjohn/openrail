"use client";

import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The site's scroll-in motion, for any page: wrap a block in `<Reveal>` (stagger parts of a section with `delay`, pick a
 * side with `from`). Used by the landing page, Features, How it works and Agent MCP; new pages use it the same way.
 *
 * Fades and slides its content into view (once). The motion is a CSS keyframe animation (`.reveal` in globals.css),
 * so the rules are:
 *
 * - Server HTML carries `.reveal`, which plays at first paint: what is on screen when the page opens (the hero)
 *   slides in with its stagger, with no JavaScript and no flash of visible-then-hidden content.
 * - Before the first paint after hydration, anything still below the screen is parked (`data-reveal="wait"`:
 *   invisible, no animation). When it scrolls near, it is set to `"in"`, which starts the same animation again.
 * - Anything on screen or above it at hydration is left alone (a page restored half way down shows its content).
 * - Reduced motion: no animation at all, content simply there (globals.css).
 *
 * Do not move the element with `transition` + Tailwind `translate-*` classes: Tailwind 4 writes the `translate`
 * property, so `transition-[opacity,transform]` fades but never slides.
 */

type From = "up" | "down" | "left" | "right" | "none";

const OFFSET: Record<From, { x: string; y: string }> = {
  up: { x: "0px", y: "24px" },
  down: { x: "0px", y: "-24px" },
  left: { x: "-32px", y: "0px" },
  right: { x: "32px", y: "0px" },
  none: { x: "0px", y: "0px" },
};

type Waiting = { el: HTMLElement; show: () => void };
const waiting = new Map<Element, Waiting>();
let observer: IntersectionObserver | null = null;

/** One observer for every Reveal on the page. */
function observe(el: HTMLElement, show: () => void): () => void {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        waiting.get(entry.target)?.show();
        waiting.delete(entry.target);
        observer?.unobserve(entry.target);
      }
    },
    // Fires when the top edge is 10% of the screen above the bottom edge, whatever the element's height.
    { rootMargin: "0px 0px -10% 0px", threshold: 0 },
  );
  waiting.set(el, { el, show });
  observer.observe(el);
  return () => {
    waiting.delete(el);
    observer?.unobserve(el);
  };
}

export function Reveal({
  children,
  delay = 0,
  from = "up",
  className,
}: {
  children: ReactNode;
  /** Milliseconds, to stagger the parts of one section. */
  delay?: number;
  /** The side it comes from. Left and right need a parent that clips (`overflow-x: clip`; `body` does). */
  from?: From;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // On screen or above it: the load animation is already running (or done). Only what is below waits.
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    el.dataset["reveal"] = "wait";
    return observe(el, () => {
      el.dataset["reveal"] = "in";
    });
  }, []);

  const offset = OFFSET[from];
  return (
    <div
      ref={ref}
      style={
        {
          "--reveal-delay": `${delay}ms`,
          "--reveal-x": offset.x,
          "--reveal-y": offset.y,
        } as CSSProperties
      }
      className={cn("reveal", className)}
    >
      {children}
    </div>
  );
}
