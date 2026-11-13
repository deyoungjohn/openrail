import type { ReactNode } from "react";
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

/** The icon files in /public/icons, by chain. A chain without one shows an empty disc. */
const CHAIN_FILE: Partial<Record<ChainId, string>> = {
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "polygon",
  bnb: "bsc",
  solana: "solana",
  near: "near",
};

/** Coins: the stablecoins have their own mark; ETH, SOL and NEAR use their chain's mark. */
const COIN_FILE: Record<string, string> = {
  USDC: "usdc",
  USDT: "usdt",
  ETH: "ethereum",
  SOL: "solana",
  NEAR: "near",
  BNB: "bsc",
  POL: "polygon",
  OP: "optimism",
  HYPE: "hyperliquid",
};

function Mark({ file, alt, size }: { file: string; alt: string; size: number }) {
  return (
    <img
      src={`/icons/${file}.svg`}
      alt=""
      aria-hidden
      data-icon={alt}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="block shrink-0 rounded-full"
    />
  );
}

export function ChainIcon({ chain, size = 20 }: { chain: ChainId; size?: number }) {
  const file = CHAIN_FILE[chain];
  if (file !== undefined) return <Mark file={file} alt={chain} size={size} />;
  // No icon supplied for this chain: an empty neutral disc, never a letter.
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="inline-block shrink-0 rounded-full bg-surface-2"
    />
  );
}

/** The mark of a coin by its symbol (USDC, USDT, ETH, SOL, NEAR). Unknown symbols show nothing. */
export function CoinIcon({ asset, size = 20 }: { asset: string; size?: number }) {
  const file = COIN_FILE[asset.toUpperCase()];
  return file === undefined ? null : <Mark file={file} alt={asset} size={size} />;
}

/** A coin with its chain as a small mark at the top right of it, like a superscript: USDC on Base. */
export function PairIcon({
  asset,
  chain,
  size = 20,
}: {
  asset: string;
  chain: ChainId;
  size?: number;
}) {
  const small = Math.max(10, Math.round(size * 0.55));
  const ring = 2;
  return (
    <span
      className="relative inline-flex shrink-0"
      // The corner mark sticks out to the right: keep that room so it never touches the words after it.
      style={{ width: size, height: size, marginRight: Math.round(small * 0.4) }}
    >
      <CoinIcon asset={asset} size={size} />
      <span
        className="absolute grid place-items-center rounded-full bg-surface"
        style={{
          width: small + ring * 2,
          height: small + ring * 2,
          top: -Math.round(small * 0.4),
          right: -Math.round(small * 0.4),
        }}
      >
        <ChainIcon chain={chain} size={small} />
      </span>
    </span>
  );
}

/** An icon with its words, for a list of choices or a line of text: "[icon] Base". */
export function WithIcon({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      {icon}
      <span>{children}</span>
    </span>
  );
}

export function ChainBadge({
  chain,
  label,
  selected,
  onSelect,
}: {
  chain: ChainId;
  /** Replaces the chain name, for example "USDC on Base". */
  label?: string;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const body = (
    <>
      <ChainIcon chain={chain} />
      <span>{label ?? CHAINS[chain]}</span>
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
          ? "border-accent bg-accent-soft text-accent-text"
          : "border-border bg-surface hover:bg-surface-2",
      )}
    >
      {body}
    </button>
  );
}
