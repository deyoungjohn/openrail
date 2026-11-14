import type { Route } from "@openrail/api-client";
import { describe, expect, it } from "vitest";
import { walletKindOf } from "./wallet-kind";

const route = (o: Partial<Route>): Route =>
  ({
    id: "R",
    origin_chain: "base",
    payer_asset: "USDC",
    origin_decimals: 6,
    origin_contract: "0xabc",
    evm_chain_id: 8453,
    ...o,
  }) as unknown as Route;

describe("walletKindOf: the wallet a route is paid from", () => {
  it("an EVM chain is paid from an EVM wallet", () => {
    expect(walletKindOf(route({}))).toBe("evm");
  });
  it("Solana USDC is paid from a Solana wallet, never an EVM one", () => {
    expect(
      walletKindOf(
        route({
          origin_chain: "solana",
          evm_chain_id: null,
          origin_contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        }),
      ),
    ).toBe("solana");
  });
  it("the native coin of Solana is not sent from a connected wallet here", () => {
    expect(
      walletKindOf(route({ origin_chain: "solana", evm_chain_id: null, origin_contract: null })),
    ).toBeNull();
  });
  it("no route chosen: no wallet", () => {
    expect(walletKindOf(null)).toBeNull();
  });
});

describe("walletKindOf: NEAR", () => {
  it("a NEAR token is paid from the connected NEAR wallet", () => {
    expect(
      walletKindOf(
        route({
          origin_chain: "near",
          evm_chain_id: null,
          origin_contract: "usdt.tether-token.near",
        }),
      ),
    ).toBe("near");
  });
});
