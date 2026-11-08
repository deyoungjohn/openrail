import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Error text that never moves the page (DESIGN.md, hard rule). The space for it is always there, empty when there
 * is nothing to say, and the message fills that space when it comes: nothing else is pushed, and the text never
 * covers a control. `field` is one line under a field (a longer message is cut with an ellipsis and its full text
 * is the tooltip); `form` is three lines under a form's button. Write
 * `<ErrorNote>{problem ? text : null}</ErrorNote>`, so the space exists whether or not there is a message.
 */
export function ErrorNote({
  children,
  variant = "form",
  className,
  id,
}: {
  children?: ReactNode;
  variant?: "field" | "form";
  className?: string;
  id?: string;
}) {
  const text = typeof children === "string" ? children : undefined;
  return (
    <div
      id={id}
      className={cn(variant === "field" ? "h-5" : "h-[3.75rem]", "w-full print:hidden", className)}
      {...(children ? { role: "alert" } : {})}
    >
      {children ? (
        <p
          title={text}
          className={cn(
            "text-danger-text flex items-start gap-1.5 text-[13px] leading-5",
            variant === "field" ? "truncate" : "line-clamp-3",
          )}
        >
          <AlertCircle aria-hidden size={14} strokeWidth={1.75} className="mt-[3px] shrink-0" />
          <span className={variant === "field" ? "truncate" : undefined}>{children}</span>
        </p>
      ) : null}
    </div>
  );
}
