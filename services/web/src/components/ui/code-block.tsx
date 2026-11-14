"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A block of code or a command with a copy button. The text copied is exactly what is shown. The button says
 * "Copied" for a moment, in place (it never moves the block or covers the code).
 */
export function CodeBlock({
  code,
  label,
  className,
}: {
  code: string;
  /** A short caption above the code (the language or what it is), shown and read out with the button. */
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked: the text can still be selected by hand.
    }
  };
  return (
    <div className={cn("overflow-hidden rounded-2xl border border-border bg-surface-2", className)}>
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border pr-1.5 pl-4">
        <span className="caption font-mono">{label ?? ""}</span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? "Copied" : `Copy${label ? ` ${label}` : ""}`}
          className="inline-flex h-9 w-[92px] items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium text-muted hover:bg-surface hover:text-text"
        >
          {copied ? <Check aria-hidden size={14} /> : <Copy aria-hidden size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-6 text-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}
