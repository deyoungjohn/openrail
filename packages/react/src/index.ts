/**
 * `<OpenrailPayButton>`: a React button that opens the hosted Openrail pay page in an accessible
 * dialog. No keys in the browser: it only needs the public pay origin and a claim id or pay path.
 * Behaviour matches the script-tag widget: closes on Esc, the close button, a backdrop click, and
 * when the pay page posts `{type: "openrail:payment-complete"}` from the pay origin.
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { isPaidMessage, payFrameUrl, payOrigin } from "./core.js";
import type { PaidMessage, PayTarget } from "./core.js";

export { isPaidMessage, payFrameUrl, payOrigin } from "./core.js";
export type { PaidMessage, PayTarget } from "./core.js";

export interface OpenrailPayButtonProps extends PayTarget {
  /** Hosted pay origin, for example `https://openrail.example`. */
  payUrl: string;
  /** Button content. Defaults to "Pay invoice". */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  /** Called once when the pay page reports the payment complete; the dialog then closes. */
  onPaid?: (message: PaidMessage) => void;
  /** Called whenever the dialog closes, paid or not. */
  onClose?: () => void;
  /** Accessible name of the dialog. Defaults to "Invoice payment". */
  dialogLabel?: string;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: "var(--openrail-z, 9999)" as unknown as number,
  display: "grid",
  placeItems: "center",
  background: "var(--openrail-overlay, rgba(0,0,0,.65))",
};
const frameStyle: CSSProperties = {
  width: "min(560px, 100%)",
  height: "min(760px, 100%)",
  border: 0,
  borderRadius: "0.5em",
  background: "var(--openrail-frame-bg, #fff)",
};
const closeStyle: CSSProperties = {
  position: "fixed",
  top: "1rem",
  right: "1rem",
  width: "2.5rem",
  height: "2.5rem",
  border: 0,
  borderRadius: "50%",
  fontSize: "1.4rem",
  lineHeight: 1,
  cursor: "pointer",
  background: "var(--openrail-close-bg, #fff)",
  color: "var(--openrail-close-fg, #111)",
};

export function OpenrailPayButton(props: OpenrailPayButtonProps) {
  const { payUrl, invoice, path, children, className, style, disabled, onPaid, onClose } = props;
  const dialogLabel = props.dialogLabel ?? "Invoice payment";
  // Validate at render so a misconfiguration fails loudly in development, not on click.
  const src = useMemo(() => payFrameUrl(payUrl, { invoice, path }), [payUrl, invoice, path]);
  const origin = useMemo(() => payOrigin(payUrl), [payUrl]);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const paidRef = useRef(false);

  const close = useCallback(() => {
    setOpen(false);
    onClose?.();
    buttonRef.current?.focus();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    paidRef.current = false;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onMessage = (event: MessageEvent) => {
      const paid = isPaidMessage(event, origin);
      if (!paid || paidRef.current) return;
      paidRef.current = true;
      onPaid?.(paid);
      close();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, [open, origin, onPaid, close]);

  const button = createElement(
    "button",
    {
      ref: buttonRef,
      type: "button",
      className: className ?? "openrail-pay-button",
      style,
      disabled,
      "aria-haspopup": "dialog",
      onClick: () => setOpen(true),
    },
    children ?? "Pay invoice",
  );

  if (!open || typeof document === "undefined") return button;

  const dialog = createElement(
    "div",
    {
      role: "dialog",
      "aria-modal": true,
      "aria-label": dialogLabel,
      className: "openrail-overlay",
      style: overlayStyle,
      onClick: (event: { target: unknown; currentTarget: unknown }) => {
        if (event.target === event.currentTarget) close();
      },
    },
    createElement("iframe", {
      className: "openrail-frame",
      title: dialogLabel,
      src,
      allow: "clipboard-write",
      style: frameStyle,
    }),
    createElement(
      "button",
      {
        ref: closeRef,
        type: "button",
        className: "openrail-close",
        "aria-label": "Close payment",
        style: closeStyle,
        onClick: close,
      },
      "×",
    ),
  );
  return createElement("span", null, button, createPortal(dialog, document.body));
}
