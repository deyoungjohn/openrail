import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * An error message that never moves anything. It takes no room in the page: the text floats just under the place
 * it is written, like a tooltip that is always open, so showing or clearing it never shifts a field, a button or
 * a row (DESIGN.md, hard rule: error text must not change the layout). The slot is always in the page, empty
 * when there is nothing to say, so a neighbour's spacing never changes either: write
 * `<ErrorNote>{problem ? text : null}</ErrorNote>`. Use it for field errors and for the failure line under a
 * form's button. A message that needs a whole panel belongs in `ErrorState`.
 */
export function ErrorNote({
  children,
  className,
  id,
}: {
  children?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <span className="relative block h-0 w-full" id={id}>
      {children ? (
        <span
          role="alert"
          className={cn(
            "pointer-events-none absolute top-1.5 left-0 z-30 flex w-max max-w-[min(22rem,calc(100vw-2rem))] items-start gap-1.5",
            "rounded-md bg-text px-2 py-1 text-[12px] leading-4 font-medium text-bg shadow-md print:hidden",
            className,
          )}
        >
          <AlertCircle
            aria-hidden
            size={14}
            strokeWidth={1.75}
            className="mt-px shrink-0 text-danger"
          />
          <span>{children}</span>
        </span>
      ) : null}
    </span>
  );
}
