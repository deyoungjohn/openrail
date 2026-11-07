"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { copy } from "@/copy";
import { Tooltip } from "./tooltip";

/**
 * Light and dark switch. The new theme opens over the old one as a rectangle rising from the bottom
 * edge (the "rectangle" variant of the beui theme toggle), using the browser's View Transitions. A
 * browser without them, or a person who asked for less motion, gets an instant switch.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === "dark";

  const toggle = () => {
    const next = dark ? "light" : "dark";
    const root = document.documentElement;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (calm || typeof document.startViewTransition !== "function") {
      setTheme(next);
      return;
    }
    root.dataset.vt = "rect";
    const run = document.startViewTransition(() => {
      flushSync(() => setTheme(next));
    });
    void run.finished.finally(() => {
      delete root.dataset.vt;
    });
  };

  return (
    <Tooltip label={dark ? copy.theme.toLight : copy.theme.toDark} side="bottom">
      <button
        type="button"
        onClick={toggle}
        aria-label={dark ? copy.theme.toLight : copy.theme.toDark}
        className={
          "relative grid size-9 place-items-center overflow-hidden rounded-[10px] border border-border bg-surface text-text transition-colors duration-[var(--dur-fast)] hover:bg-surface-2 print:hidden " +
          (className ?? "")
        }
      >
        <Sun
          size={18}
          strokeWidth={1.5}
          aria-hidden
          className={
            "col-start-1 row-start-1 transition-[opacity,transform] duration-[var(--dur)] ease-[var(--ease)] " +
            (dark ? "scale-100 rotate-0 opacity-100" : "scale-50 -rotate-45 opacity-0")
          }
        />
        <Moon
          size={18}
          strokeWidth={1.5}
          aria-hidden
          className={
            "col-start-1 row-start-1 transition-[opacity,transform] duration-[var(--dur)] ease-[var(--ease)] " +
            (dark ? "scale-50 rotate-45 opacity-0" : "scale-100 rotate-0 opacity-100")
          }
        />
      </button>
    </Tooltip>
  );
}
