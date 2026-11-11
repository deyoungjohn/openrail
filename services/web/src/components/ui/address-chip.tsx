"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { copy } from "@/copy";
import { middleTruncate } from "@/lib/format";
import { explorerTxUrl } from "@/lib/w5";
import { ChainIcon, type ChainId } from "./chain-badge";
import { Tooltip } from "./tooltip";

export function AddressChip({
  value,
  chain,
  href,
  tx,
  head,
  tail,
}: {
  value: string;
  chain?: ChainId;
  /** Explorer link. Omit when none is known. */
  href?: string;
  /** The value is a transaction hash: with a chain, the shortened hash itself is the link to its explorer. */
  tx?: boolean;
  head?: number;
  tail?: number;
}) {
  const [copied, setCopied] = useState(false);
  const explorer = href ?? (tx && chain ? explorerTxUrl(chain, value) : null);
  const asLink = tx === true && explorer !== null;

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
      {/* On paper there is no hover and no copy button, so the whole value is printed: the shortened
          text is hidden and the full value comes from data-full. One element, so screen readers and
          tests see the value once. */}
      <code
        title={value}
        data-full={value}
        className="font-mono text-[13px] leading-5 font-normal break-all print:text-[0px] print:before:text-[11px] print:before:leading-4 print:before:content-[attr(data-full)]"
      >
        {asLink ? (
          <a
            href={explorer}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`${copy.address.view}: ${middleTruncate(value)}`}
            className="text-accent-text underline-offset-2 hover:underline focus-visible:underline"
          >
            {middleTruncate(value, head, tail)}
          </a>
        ) : (
          middleTruncate(value, head, tail)
        )}
      </code>
      {/* On paper there is no hover and no copy button, so the whole value is written out. */}
      <Tooltip label={copied ? copy.address.copied : copy.address.copy} side="top">
        <button
          type="button"
          onClick={onCopy}
          aria-label={
            copied ? copy.address.copied : `${copy.address.copy} ${middleTruncate(value)}`
          }
          className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text print:hidden"
        >
          {copied ? (
            <Check size={16} strokeWidth={1.5} aria-hidden />
          ) : (
            <Copy size={16} strokeWidth={1.5} aria-hidden />
          )}
        </button>
      </Tooltip>
      {explorer && !asLink ? (
        <Tooltip label={copy.address.view} side="top">
          <a
            href={explorer ?? undefined}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`${copy.address.view}: ${middleTruncate(value)}`}
            className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text print:hidden"
          >
            <ExternalLink size={16} strokeWidth={1.5} aria-hidden />
          </a>
        </Tooltip>
      ) : null}
    </span>
  );
}

/** A transaction hash: an AddressChip with an explorer link. */
export function TxLink(props: Omit<Parameters<typeof AddressChip>[0], "head" | "tail">) {
  return <AddressChip head={6} tail={4} tx {...props} />;
}
