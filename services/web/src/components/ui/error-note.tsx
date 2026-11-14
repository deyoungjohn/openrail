import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Error text in a space that is always there (DESIGN.md, hard rule): one line under a field or a form's button, empty
 * when there is nothing to say, so a short message moves nothing and no message ever covers a control. A longer message
 * is shown in full: it wraps, and the space opens below it smoothly to fit, never cut with an ellipsis (14 Nov, human:
 * cut messages hid what went wrong). `variant` is kept for callers and does not change the size. Write
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
  return (
    <div
      id={id}
      className={cn(
        // contain: inline-size, so a long message wraps inside its column and never widens it
        "-mt-1 min-h-5 w-full min-w-0 [contain:inline-size] print:hidden",
        "h-auto transition-[height] duration-200 ease-out [interpolate-size:allow-keywords] motion-reduce:transition-none",
        className,
      )}
      {...(children ? { role: "alert" } : {})}
    >
      {children ? (
        <p className="text-danger-text flex items-start gap-1.5 text-[13px] leading-5 break-words">
          <AlertCircle aria-hidden size={14} strokeWidth={1.75} className="mt-[3px] shrink-0" />
          <span className="min-w-0">{children}</span>
        </p>
      ) : null}
    </div>
  );
}
