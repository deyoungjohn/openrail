import { cn } from "@/lib/cn";

export const CHAINS = {
  ethereum: "Ethereum",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  polygon: "Polygon",
  bnb: "BNB Chain",
  solana: "Solana",
  near: "NEAR",
} as const;

export type ChainId = keyof typeof CHAINS;

// Placeholder mark: a neutral initial, not a logo. Official chain SVGs are used as-is once
// supplied (DESIGN.md section 6); they are not redrawn here.
export function ChainIcon({ chain, size = 20 }: { chain: ChainId; size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.5 }}
      className="inline-grid shrink-0 place-items-center rounded-full bg-surface-2 font-semibold text-text"
    >
      {CHAINS[chain][0]}
    </span>
  );
}

export function ChainBadge({
  chain,
  selected,
  onSelect,
}: {
  chain: ChainId;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const body = (
    <>
      <ChainIcon chain={chain} />
      <span>{CHAINS[chain]}</span>
    </>
  );
  const cls =
    "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[14px] leading-5 font-medium";
  if (!onSelect) return <span className={cn(cls, "border-border bg-surface")}>{body}</span>;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        cls,
        "transition-colors duration-[var(--dur-fast)]",
        selected
          ? "border-accent bg-accent-soft text-accent"
          : "border-border bg-surface hover:bg-surface-2",
      )}
    >
      {body}
    </button>
  );
}
