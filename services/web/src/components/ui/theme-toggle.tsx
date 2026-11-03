"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { copy } from "@/copy";

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? copy.theme.toLight : copy.theme.toDark}
      className={
        "grid size-9 place-items-center rounded-[10px] border border-border bg-surface text-text transition-colors duration-[var(--dur-fast)] hover:bg-surface-2 print:hidden " +
        (className ?? "")
      }
    >
      {dark ? (
        <Sun size={18} strokeWidth={1.5} aria-hidden />
      ) : (
        <Moon size={18} strokeWidth={1.5} aria-hidden />
      )}
    </button>
  );
}
