"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface RingItem {
  title: string;
  description: string;
  /** A screenshot of the app, or a drawn screen (`node`) when no screenshot fits. */
  image?: string;
  node?: ReactNode;
}

/**
 * A ring of app screens: it spins, blurs while it moves, and settles on the nearest screen. Drag, use the arrows or
 * the keyboard; it turns on its own every few seconds until the visitor touches it. Built for this page in the manner
 * of React Bits' "Momentum Ring" (the Pro component needs a licence key this build does not have).
 */
export function Ring({ items }: { items: RingItem[] }) {
  const n = items.length;
  const step = 360 / n;
  const stage = useRef<HTMLDivElement>(null);
  const rot = useRef(0); // in items, continuous
  const target = useRef(0);
  const drag = useRef<{ x: number; start: number; v: number; t: number } | null>(null);
  const touchedAt = useRef(0);
  const [active, setActive] = useState(0);
  const [width, setWidth] = useState(640);

  useEffect(() => {
    const on = () => setWidth(Math.min(680, Math.max(280, window.innerWidth * 0.62)));
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  const radius = width / 2 / Math.tan(Math.PI / n) + 40;

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = rot.current;
    const frame = () => {
      if (drag.current === null)
        rot.current += (target.current - rot.current) * (reduce ? 1 : 0.09);
      const speed = Math.abs(rot.current - last);
      last = rot.current;
      const el = stage.current;
      if (el !== null) {
        el.style.transform = `translateZ(${-radius}px) rotateY(${-rot.current * step}deg)`;
        // The blur goes on each card, never on this stage: a filter on a 3D stage flattens it, and the ring showed as
        // one wide strip while it turned.
        el.style.setProperty(
          "--ring-blur",
          speed > 0.004 && !reduce ? `blur(${Math.min(5, speed * 50).toFixed(2)}px)` : "none",
        );
      }
      const idx = ((Math.round(rot.current) % n) + n) % n;
      setActive((a) => (a === idx ? a : idx));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const auto = reduce
      ? 0
      : window.setInterval(() => {
          // Turns on its own, and again 6 s after the visitor last touched it.
          if (performance.now() - touchedAt.current > 6000 && drag.current === null)
            target.current += 1;
        }, 4200);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(auto);
    };
  }, [n, radius, step]);

  const go = useCallback((d: number) => {
    touchedAt.current = performance.now();
    target.current = Math.round(target.current) + d;
  }, []);

  return (
    <div
      className="relative rounded-3xl outline-none select-none focus-visible:ring-2 focus-visible:ring-accent"
      role="region"
      aria-roledescription="carousel"
      aria-label="The app, screen by screen"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(1);
        if (e.key === "ArrowLeft") go(-1);
      }}
    >
      <div
        className="relative mx-auto h-[min(62vw,460px)] cursor-grab touch-pan-y [perspective:1800px] active:cursor-grabbing"
        onPointerDown={(e) => {
          touchedAt.current = performance.now();
          drag.current = { x: e.clientX, start: rot.current, v: 0, t: performance.now() };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d === null) return;
          const next = d.start - (e.clientX - d.x) / (width * 0.9);
          const now = performance.now();
          d.v = (next - rot.current) / Math.max(1, now - d.t);
          d.t = now;
          rot.current = next;
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d !== null) target.current = Math.round(rot.current + d.v * 220);
        }}
        onPointerCancel={() => {
          drag.current = null;
          target.current = Math.round(rot.current);
        }}
      >
        <div
          ref={stage}
          className="absolute top-1/2 left-1/2 [transform-style:preserve-3d]"
          style={{ width: 0, height: 0 }}
        >
          {items.map((it, i) => (
            <figure
              key={it.title}
              aria-hidden={i !== active}
              className="absolute overflow-hidden rounded-[22px] border border-border bg-surface [backface-visibility:hidden]"
              style={{
                width,
                height: width * 0.62,
                left: -width / 2,
                top: -(width * 0.62) / 2,
                transform: `rotateY(${i * step}deg) translateZ(${radius}px)`,
                filter: "var(--ring-blur, none)",
              }}
            >
              {it.image ? (
                <Image
                  src={it.image}
                  alt={it.title}
                  fill
                  sizes="680px"
                  className="object-cover object-top"
                  draggable={false}
                  unoptimized
                />
              ) : (
                it.node
              )}
            </figure>
          ))}
        </div>
      </div>
      <div className="mx-auto mt-6 flex max-w-[640px] items-center justify-between gap-4 px-4">
        <button
          type="button"
          aria-label="Previous screen"
          onClick={() => go(-1)}
          className="grid size-11 shrink-0 place-items-center rounded-full border border-border hover:bg-surface-2"
        >
          <ChevronLeft aria-hidden size={18} />
        </button>
        <div className="min-h-[72px] text-center" aria-live="polite">
          <p className="text-[18px] leading-[26px] font-semibold">{items[active]?.title}</p>
          <p className="mt-1 text-[15px] leading-6 text-muted">{items[active]?.description}</p>
        </div>
        <button
          type="button"
          aria-label="Next screen"
          onClick={() => go(1)}
          className="grid size-11 shrink-0 place-items-center rounded-full border border-border hover:bg-surface-2"
        >
          <ChevronRight aria-hidden size={18} />
        </button>
      </div>
    </div>
  );
}
