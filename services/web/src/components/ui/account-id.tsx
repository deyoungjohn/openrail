"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { copy } from "@/copy";
import { cn } from "@/lib/cn";
import { accountDisplay } from "@/lib/near-account";
import { Tooltip } from "./tooltip";

/**
 * A NEAR account. Named accounts show whole; an implicit one (64 hex, from multichain wallets) is
 * middle-truncated with both ends visible, the full value in the tooltip and a copy button.
 * `full` prints every character, for places where a mistake must be visible, like the account a
 * client must sign in with.
 */
export function AccountId({
  value,
  full,
  className,
}: {
  value: string;
  full?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const d = accountDisplay(value, { full });
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 align-middle", className)}>
      <code title={value} className="font-mono text-[13px] leading-5 font-normal break-all">
        {d.text}
      </code>
      {d.truncated ? (
        <Tooltip label={copied ? copy.address.copied : `${copy.address.copy} ${d.text}`} side="top">
          <button
            type="button"
            aria-label={copied ? copy.address.copied : `${copy.address.copy} ${d.text}`}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                // The full value is in the tooltip.
              }
            }}
            className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
          >
            {copied ? (
              <Check size={16} strokeWidth={1.5} aria-hidden />
            ) : (
              <Copy size={16} strokeWidth={1.5} aria-hidden />
            )}
          </button>
        </Tooltip>
      ) : null}
    </span>
  );
}
