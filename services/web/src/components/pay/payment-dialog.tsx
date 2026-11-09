"use client";

import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { copy } from "@/copy";

/**
 * The payment (price, address, QR code, progress) in a pop-over that can be closed and opened again while the
 * payment is not settled. Its content stays mounted when it is closed, so the status keeps being read and the page
 * behind stays in step.
 */
export function PaymentDialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    close.current?.focus({ preventScroll: true });
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      // A dialog inside this one (the notes) closes first.
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
      opener.current?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

  return (
    <div
      hidden={!open}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-2 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="surface-card relative my-auto w-full max-w-lg p-4 sm:p-6"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-[20px] leading-7 font-semibold">{title}</h2>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            aria-label={copy.pay.closeDetails}
            className="grid size-9 place-items-center rounded-full text-muted outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X aria-hidden size={18} strokeWidth={1.5} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
