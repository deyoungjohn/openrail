"use client";

import { X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { copy } from "@/copy";

/**
 * The payment (price, address, QR code, progress) in a pop-over that can be closed and opened again while the
 * payment is not settled. Its content stays mounted when it is closed, so the status keeps being read and the page
 * behind stays in step.
 */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

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
  const panel = useRef<HTMLDivElement>(null);
  // The pop-over lives on <body>: inside the page it sits in a transformed container, where `fixed` means "fixed to
  // that container", so the scrim stopped at the page column and a click outside it never reached the dialog.
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);

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

  // Tab stays inside the pop-over while it is open (the notes dialog opened from inside it keeps its own loop).
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || document.querySelector("dialog[open]")) return;
    const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
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

  if (host === null) return null;
  return createPortal(
    <div
      hidden={!open}
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-[var(--scrim)] p-2 [backdrop-filter:var(--scrim-blur)] sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="surface-card relative my-auto w-full max-w-4xl p-4 sm:p-6"
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
        {/* One surface: the cards inside lose their own frames, so the price, the code and the progress read as one.
            `.surface-card` is plain CSS outside Tailwind's layers, so only an important utility beats its border,
            fill and radius (the first version of this did not, and left the frames on a padding-less card). */}
        <div className="[&_.surface-card]:rounded-none! [&_.surface-card]:border-0! [&_.surface-card]:bg-transparent! [&_.surface-card]:p-0! [&_.surface-card]:shadow-none!">
          {children}
        </div>
      </div>
    </div>,
    host,
  );
}
