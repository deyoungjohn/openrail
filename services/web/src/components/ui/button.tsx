import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { copy } from "@/copy";
import { Loader } from "./loader";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover border border-transparent",
  secondary: "bg-surface text-text border border-border hover:bg-surface-2",
  ghost: "bg-transparent text-text border border-transparent hover:bg-surface-2",
  danger: "bg-danger text-on-danger border border-transparent hover:opacity-90",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[10px] px-4 text-[14px] leading-5 font-medium",
        "transition-[background-color,border-color,transform] duration-[var(--dur-fast)] ease-[var(--ease)]",
        "active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60",
        size === "sm" ? "h-9" : "h-11",
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span aria-hidden>
          <Loader
            variant="spinner"
            size={18}
            label=""
            className={
              variant === "primary"
                ? "text-on-accent"
                : variant === "danger"
                  ? "text-on-danger"
                  : "text-accent"
            }
          />
        </span>
      ) : (
        icon
      )}
      {children}
      {loading ? <span className="sr-only">{copy.states.loading}</span> : null}
    </button>
  );
}
