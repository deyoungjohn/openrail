import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Error text that never moves the page (DESIGN.md, hard rule). The space for it is always there, empty when there
 * is nothing to say, and the message fills that space when it comes: nothing else is pushed, and the text never
 * covers a control. one line under a field or a form's button (a longer message is cut with an ellipsis and its full text
 * is the tooltip and what a screen reader reads). `variant` is kept for callers and no longer changes the size. Write
 * `<ErrorNote>{problem ? text : null}</ErrorNote>`, so the space exists whether or not there is a message.
 */
export function ErrorNote({
  children,
  className,
  id,
}: {
  children?: ReactNode;
  /** Kept for callers; the size is the same for both. */
  variant?: "field" | "form";
  className?: string;
  id?: string;
}) {
  const text = typeof children === "string" ? children : undefined;
  return (
    <div
      id={id}
      className={cn(
        "h-5", // contain: inline-size, so a long message never widens the column it sits in
        "-mt-1 w-full min-w-0 overflow-hidden [contain:inline-size] print:hidden",
        className,
      )}
      {...(children ? { role: "alert" } : {})}
    >
      {children ? (
        <p
          title={text}
          className={cn(
            "text-danger-text flex items-start gap-1.5 text-[13px] leading-5",
            "truncate",
          )}
        >
          <AlertCircle aria-hidden size={14} strokeWidth={1.75} className="mt-[3px] shrink-0" />
          <span className="truncate">{children}</span>
        </p>
      ) : null}
    </div>
  );
}
