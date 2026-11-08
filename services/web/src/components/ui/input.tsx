"use client";

import {
  Children,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { ErrorNote } from "./error-note";
import {
  Select as MotionSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./motion-select";

interface FrameProps {
  label: string;
  helper?: string;
  error?: string;
  icon?: ReactNode;
  loading?: boolean;
}

/**
 * A floating label (the pattern of the Spectrum "floating label input"): the label sits inside the field like a
 * placeholder, and moves up onto the top border when the field is focused or has a value. The input must come
 * before the label in the markup and carry the `peer` class: the label reads the input's focus and
 * `:placeholder-shown` state. A select, and the date and time inputs, always show something, so their label
 * is always up.
 */
function Frame({
  id,
  label,
  helper,
  error,
  icon,
  loading,
  floated,
  children,
}: FrameProps & { id: string; floated?: boolean; children: ReactNode }) {
  return (
    <div className="w-full">
      <div className="relative">
        {loading ? <div className="skeleton h-11 w-full" aria-hidden /> : children}
        {icon ? (
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
            {icon}
          </span>
        ) : null}
        <label
          htmlFor={id}
          className={cn(
            "pointer-events-none absolute z-10 origin-left bg-transparent px-1 leading-5 text-muted",
            "transition-[top,font-size,transform,background-color,color] duration-[var(--dur-fast)] ease-[var(--ease)]",
            // Up: on the top border, with the field's own background behind it so the border reads as a notch.
            floated
              ? "top-0 left-3 -translate-y-1/2 bg-surface text-[12px] font-medium dark:bg-surface-2"
              : cn(
                  icon ? "left-10" : "left-3",
                  "top-1/2 -translate-y-1/2 text-[15px]",
                  "peer-focus:top-0 peer-focus:left-3 peer-focus:bg-surface peer-focus:text-[12px] peer-focus:font-medium peer-focus:text-accent-text dark:peer-focus:bg-surface-2",
                  "peer-[:not(:placeholder-shown)]:top-0 peer-[:not(:placeholder-shown)]:left-3 peer-[:not(:placeholder-shown)]:bg-surface peer-[:not(:placeholder-shown)]:text-[12px] peer-[:not(:placeholder-shown)]:font-medium dark:peer-[:not(:placeholder-shown)]:bg-surface-2",
                ),
            error && "!text-danger-text",
          )}
        >
          {label}
        </label>
      </div>
      {/* One cell holds both the helper line and the error: the cell is as tall as the taller of the two, so
          swapping one for the other moves nothing. */}
      <div className="grid">
        {helper ? (
          <p
            id={error ? undefined : `${id}-note`}
            aria-hidden={error ? true : undefined}
            className={cn("caption col-start-1 row-start-1 mt-1.5 px-1", error && "invisible")}
          >
            {helper}
          </p>
        ) : null}
        <ErrorNote
          variant="field"
          id={error ? `${id}-note` : undefined}
          className="col-start-1 row-start-1 mt-1.5 px-1"
        >
          {error ? error : null}
        </ErrorNote>
      </div>
    </div>
  );
}

/** Input types that always display something (a mask, a file name), so the label is always up. */
const ALWAYS_UP = ["date", "datetime-local", "time", "month", "week", "file", "color"];

const field =
  "h-11 w-full rounded-[10px] border bg-surface px-3 dark:bg-surface-2 text-[15px] text-text " +
  "transition-[border-color] duration-[var(--dur-fast)] ease-[var(--ease)] " +
  // The label is the placeholder; a real placeholder only shows once the label has moved up.
  "placeholder:text-transparent focus:placeholder:text-muted focus-visible:border-accent " +
  "disabled:opacity-60";

export function Input({
  label,
  helper,
  error,
  icon,
  loading,
  className,
  ...rest
}: FrameProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const type = rest.type ?? "text";
  return (
    <Frame id={id} floated={ALWAYS_UP.includes(type)} {...{ label, helper, error, icon, loading }}>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || helper ? `${id}-note` : undefined}
        className={cn(
          field,
          "peer",
          error ? "border-danger" : "border-border",
          icon && "pl-10",
          className,
        )}
        {...rest}
        placeholder={rest.placeholder ?? " "}
      />
    </Frame>
  );
}

/**
 * A choice from a short list, on the motion select (beui). Give it `<option value>` children, like a native select;
 * the chosen value comes back through `onValueChange`. The label is always up, as on a native select.
 */
export function Select({
  label,
  helper,
  error,
  icon,
  loading,
  className,
  children,
  value,
  defaultValue,
  onValueChange,
  disabled,
}: FrameProps & {
  className?: string;
  children: ReactNode;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const options = Children.toArray(children).filter(isValidElement) as ReactElement<{
    value?: string;
    children?: ReactNode;
  }>[];
  return (
    <Frame id={id} floated {...{ label, helper, error, icon, loading }}>
      <MotionSelect
        {...(value !== undefined ? { value } : {})}
        {...(defaultValue !== undefined ? { defaultValue } : {})}
        {...(onValueChange ? { onValueChange } : {})}
        {...(disabled !== undefined ? { disabled } : {})}
      >
        <SelectTrigger
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || helper ? `${id}-note` : undefined}
          className={cn(error ? "border-danger" : "border-border", icon && "pl-10", className)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.props.value ?? ""} value={o.props.value ?? ""}>
              {o.props.children as string}
            </SelectItem>
          ))}
        </SelectContent>
      </MotionSelect>
    </Frame>
  );
}
