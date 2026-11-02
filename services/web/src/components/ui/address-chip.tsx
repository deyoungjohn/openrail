"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { copy } from "@/copy";
import { middleTruncate } from "@/lib/format";
import { ChainIcon, type ChainId } from "./chain-badge";

export function AddressChip({
  value,
  chain,
  href,
  head,
  tail,
}: {
  value: string;
  chain?: ChainId;
  /** Explorer link. Omit when none is known. */
  href?: string;
  head?: number;
  tail?: number;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the full value is on hover and in the link.
    }
  };

  return (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
      {chain ? <ChainIcon chain={chain} size={18} /> : null}
      <code title={value} className="font-mono text-[13px] leading-5 font-normal">
        {middleTruncate(value, head, tail)}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? copy.address.copied : `${copy.address.copy} ${middleTruncate(value)}`}
        className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
      >
        {copied ? (
          <Check size={16} strokeWidth={1.5} aria-hidden />
        ) : (
          <Copy size={16} strokeWidth={1.5} aria-hidden />
        )}
      </button>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`${copy.address.view}: ${middleTruncate(value)}`}
          className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
        >
          <ExternalLink size={16} strokeWidth={1.5} aria-hidden />
        </a>
      ) : null}
    </span>
  );
}

/** A transaction hash: an AddressChip with an explorer link. */
export function TxLink(props: Omit<Parameters<typeof AddressChip>[0], "head" | "tail">) {
  return <AddressChip head={6} tail={4} {...props} />;
}
