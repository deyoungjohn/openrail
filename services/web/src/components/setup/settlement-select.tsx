"use client";

import { PairIcon, type ChainId } from "../ui/chain-badge";
import { Select } from "../ui/input";
import { copy } from "@/copy";

/** The four assets a business can be paid in (the API's settlement assets). The first is the default. */
export const SETTLEMENT_OPTIONS = [
  {
    id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    label: "USDC on NEAR",
  },
  { id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", label: "USDC on Base" },
  {
    id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    label: "USDC on Arbitrum",
  },
  { id: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", label: "USDC on Solana" },
] as const;

const CHAIN_OF: Record<string, ChainId> = {
  NEAR: "near",
  Base: "base",
  Arbitrum: "arbitrum",
  Solana: "solana",
};

export const DEFAULT_SETTLEMENT = SETTLEMENT_OPTIONS[0].id;

/** Where the business wants to be paid: every checkout and invoice settles in this asset, whatever chain the payer uses. */
export function SettlementSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const t = copy.setup;
  return (
    <div className="space-y-1">
      <Select label={t.settlementLabel} value={value} onValueChange={onChange}>
        {SETTLEMENT_OPTIONS.map((o) => (
          <option
            key={o.id}
            value={o.id}
            data-icon={
              <PairIcon
                asset="USDC"
                chain={CHAIN_OF[o.label.split(" on ")[1] ?? "NEAR"] ?? "near"}
              />
            }
          >
            {o.label}
          </option>
        ))}
      </Select>
      <p className="caption">{t.settlementHelp}</p>
    </div>
  );
}
