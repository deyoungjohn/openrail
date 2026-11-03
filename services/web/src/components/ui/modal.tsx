"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { copy } from "@/copy";
import { cn } from "@/lib/cn";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal and side drawer on a native <dialog>: the browser gives us the top layer, Esc and
 * `inert` for the page behind. We add a Tab loop and return focus to the opener.
 */
export function Modal({
  open,
  onClose,
  title,
  variant = "modal",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  variant?: "modal" | "drawer";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // `shown` lags `open` so the enter and exit transitions (320 ms) can play.
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open) {
      opener.current = document.activeElement as HTMLElement | null;
      if (!dlg.open) dlg.showModal();
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = setTimeout(
      () => {
        if (dlg.open) dlg.close();
        opener.current?.focus();
      },
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 320,
    );
    return () => clearTimeout(t);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== "Tab") return;
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={ref}
      className="overlay"
      aria-labelledby="modal-title"
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div
        className={cn(
          "flex h-full w-full p-4",
          variant === "drawer" ? "items-stretch justify-end" : "items-center justify-center",
        )}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className={cn(
            "surface-card flex max-h-full flex-col overflow-hidden",
            "transition-[opacity,transform] duration-[var(--dur-slow)]",
            variant === "drawer" ? "w-full max-w-md" : "w-full max-w-lg",
            shown
              ? "translate-x-0 translate-y-0 opacity-100 ease-[var(--ease)]"
              : cn(
                  "opacity-0 ease-[var(--ease-exit)]",
                  variant === "drawer" ? "translate-x-8" : "translate-y-2",
                ),
          )}
        >
          <header className="flex items-center gap-2 border-b border-border px-6 py-4">
            <h2 id="modal-title" className="text-[18px] leading-[26px] font-semibold">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={copy.modal.close}
              className="ml-auto grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2"
            >
              <X size={18} strokeWidth={1.5} aria-hidden />
            </button>
          </header>
          <div className="overflow-y-auto p-6">{children}</div>
        </div>
      </div>
    </dialog>
  );
}
