"use client";

import { AlertCircle } from "lucide-react";
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

interface FrameProps {
  label: string;
  helper?: string;
  error?: string;
  icon?: ReactNode;
  loading?: boolean;
}

function Frame({
  id,
  label,
  helper,
  error,
  icon,
  loading,
  children,
}: FrameProps & { id: string; children: ReactNode }) {
  const note = error ?? helper;
  return (
    <div className="w-full">
      <div className="relative">
        <label
          htmlFor={id}
          className="absolute -top-2.5 left-3 z-10 bg-surface px-1 text-[12px] dark:bg-surface-2 leading-5 font-medium text-muted"
        >
          {label}
        </label>
        {icon ? (
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
            {icon}
          </span>
        ) : null}
        {loading ? <div className="skeleton h-11 w-full" aria-hidden /> : children}
      </div>
      {note ? (
        <p
          id={`${id}-note`}
          className={cn("mt-1.5 flex items-center gap-1 px-1", error ? "text-danger" : "caption")}
          style={error ? { fontSize: 13, lineHeight: "18px", fontWeight: 400 } : undefined}
        >
          {error ? <AlertCircle size={14} strokeWidth={1.5} aria-hidden /> : null}
          {note}
        </p>
      ) : null}
    </div>
  );
}

const field =
  "h-11 w-full rounded-[10px] border bg-surface px-3 dark:bg-surface-2 text-[15px] text-text " +
  "transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease)] " +
  "placeholder:text-muted focus-visible:border-accent focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60";

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
  return (
    <Frame id={id} {...{ label, helper, error, icon, loading }}>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || helper ? `${id}-note` : undefined}
        className={cn(field, error ? "border-danger" : "border-border", icon && "pl-10", className)}
        {...rest}
      />
    </Frame>
  );
}

export function Select({
  label,
  helper,
  error,
  icon,
  loading,
  className,
  children,
  ...rest
}: FrameProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Frame id={id} {...{ label, helper, error, icon, loading }}>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || helper ? `${id}-note` : undefined}
        className={cn(field, error ? "border-danger" : "border-border", icon && "pl-10", className)}
        {...rest}
      >
        {children}
      </select>
    </Frame>
  );
}
