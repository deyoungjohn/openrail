// What a business holds from the payments it received. A payment is paid out to the business as a balance of
// `intents.near` (a multi-token contract), not as a token in its NEAR wallet, so a wallet shows nothing: this
// reads the balance there, through the API (which reads the chain).

import { dashClient } from "./client";

/** The contract that holds the balances. */
export const INTENTS_CONTRACT = "intents.near";

/** USDC as `intents.near` names it, with the network each one is on. All have six decimals. */
const USDC_TOKENS: { match: RegExp; network: string }[] = [
  {
    match: /^nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913\.omft\.near$/,
    network: "Base",
  },
  {
    match: /^nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831\.omft\.near$/,
    network: "Arbitrum",
  },
  {
    match: /^nep141:op-0x0b2c639c533813f4aa9d7837caf62653d097ff85\.omft\.near$/,
    network: "Optimism",
  },
  {
    match: /^nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359\.omft\.near$/,
    network: "Polygon",
  },
  {
    match: /^nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48\.omft\.near$/,
    network: "Ethereum",
  },
  { match: /^nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186\.omft\.near$/, network: "Solana" },
  {
    match: /^nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1$/,
    network: "NEAR",
  },
];

export interface BalanceLine {
  tokenId: string;
  network: string;
  /** USDC base units (six decimals). */
  units: bigint;
}

export interface Balance {
  /** Total USDC, base units. */
  total: bigint;
  lines: BalanceLine[];
  /** Tokens held that are not USDC: listed by id, not valued. */
  otherTokens: string[];
}

export const usdcNetwork = (tokenId: string): string | null =>
  USDC_TOKENS.find((t) => t.match.test(tokenId))?.network ?? null;

/** The USDC balance of a NEAR account on `intents.near`, per network, read live from the chain. */
export async function readBalance(): Promise<Balance> {
  // The server reads the chain (with its own endpoints and keys); the browser makes no RPC call of its own.
  const { balances } = await dashClient.balance.intents();
  const lines: BalanceLine[] = [];
  const otherTokens: string[] = [];
  for (const { token_id: tokenId, amount } of balances) {
    const network = usdcNetwork(tokenId);
    const units = BigInt(amount);
    if (units === 0n) continue;
    if (network) lines.push({ tokenId, network, units });
    else otherTokens.push(tokenId);
  }
  return { total: lines.reduce((n, l) => n + l.units, 0n), lines, otherTokens };
}
