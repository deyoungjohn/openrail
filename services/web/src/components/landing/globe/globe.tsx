"use client";

import { useEffect, useRef, useState } from "react";

interface Scene {
  dispose(): void;
  setColors(c: Record<string, string>): void;
}

/**
 * The globe's own colours, the same in both themes: it was drawn for dark mode (off-white land, a dark sea, accent arcs),
 * and on the light page the light tokens made the sea vanish into the page (14 Nov, human).
 */
function colors(): Record<string, string> {
  return { ink: "#EDEBE6", dim: "#2F2F35", accent: "#3f46fe", mint: "#3f46fe", bg: "#0A0A0B" };
}

/**
 * The hero globe: payments arc between points and settle, the ten coin and chain icons ride its orbit. Drag to spin,
 * tap to send one. It loads after the page (three.js is only fetched here) and shows a line drawing until it is ready.
 */
export function Globe() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [THREE, world] = await Promise.all([import("three/webgpu"), import("./world.js")]);
      if (cancelled || canvas.current === null) return;
      const s = (await world.mount(canvas.current, {
        THREE,
        iconBase: "/icons/",
        colors,
        onRequest({ x, y }: { x: number; y: number }) {
          const chip = document.createElement("div");
          chip.className = "globe-chip";
          chip.innerHTML = "<i></i>payment <b>settled</b>";
          chip.style.left = `${x}px`;
          chip.style.top = `${y}px`;
          box.current?.append(chip);
          setTimeout(() => chip.remove(), 2500);
        },
      })) as Scene;
      if (cancelled) {
        s.dispose();
        return;
      }
      scene.current = s;
      setReady(true);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  // Follow the page's theme attribute itself: next-themes sets it in its own effect, after this component's effects
  // have run, so reading it on a theme change got the old theme and painted a light (white) globe in dark mode.
  useEffect(() => {
    if (!ready) return;
    const paint = () => scene.current?.setColors(colors());
    paint();
    const watch = new MutationObserver(paint);
    watch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    return () => watch.disconnect();
  }, [ready]);

  return (
    <div ref={box} className="relative aspect-square w-full">
      {ready ? null : (
        <svg
          viewBox="0 0 400 400"
          aria-hidden
          fill="none"
          stroke="currentColor"
          className="absolute inset-[8%] text-border"
        >
          <circle cx="200" cy="200" r="150" />
          <ellipse cx="200" cy="200" rx="60" ry="150" />
          <ellipse cx="200" cy="200" rx="115" ry="150" />
          <path d="M50 200h300M70 125h260M70 275h260" />
          <ellipse
            cx="200"
            cy="200"
            rx="190"
            ry="54"
            transform="rotate(-18 200 200)"
            strokeDasharray="3 6"
          />
        </svg>
      )}
      <canvas
        ref={canvas}
        role="img"
        aria-label="A globe of payments arriving from many chains and settling. Drag to spin, tap to send one."
        className="absolute inset-0 size-full cursor-grab touch-pan-y active:cursor-grabbing"
      />
    </div>
  );
}
