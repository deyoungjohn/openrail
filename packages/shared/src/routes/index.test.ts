import { describe, expect, it } from "vitest";
import {
  UnknownRouteError,
  allowedRoutes,
  assertAllowedRoute,
  decimalsFor,
  defaultSettlementAsset,
  getRoute,
  isAllowedRoute,
  isNep141,
  isNep245,
  loadRoutes,
  quoteAmount,
  routesForChain,
  settlementAssets,
  tokenIdFor,
  tokenStandard,
  usdToBaseUnits,
} from "./index.js";

describe("route registry data", () => {
  it("loads config/routes.json with the expected routes and four settlement assets", () => {
    const file = loadRoutes();
    expect(file.routes).toHaveLength(18);
    expect(settlementAssets()).toHaveLength(4);
    expect(new Set(settlementAssets()).size).toBe(4);
  });

  it("throws UnknownRouteError for an unknown route", () => {
    expect(() => getRoute("R99")).toThrow(UnknownRouteError);
  });

  it("allow-lists only known routes", () => {
    expect(isAllowedRoute("R1")).toBe(true);
    expect(isAllowedRoute("R99")).toBe(false);
    expect(() => assertAllowedRoute("R99")).toThrow(UnknownRouteError);
    expect(allowedRoutes().map((route) => route.id)).toEqual(
      loadRoutes().routes.map((route) => route.id),
    );
  });
});

describe("token ids, decimals and standards", () => {
  it("returns a token id per chain and payer asset", () => {
    expect(tokenIdFor("base", "USDC")).toBe(getRoute("R1").originAssetId);
    expect(tokenIdFor("base", "ETH")).toBe(getRoute("R10").originAssetId);
    expect(tokenIdFor("solana", "USDC")).toBe(getRoute("R7").originAssetId);
    expect(routesForChain("base").map((route) => route.id)).toEqual(["R1", "R10"]);
  });

  it("keeps BNB USDC at 18 decimals and the other USDC routes at 6", () => {
    expect(decimalsFor(getRoute("R6"))).toBe(18);
    for (const route of loadRoutes().routes.filter(
      (entry) => entry.payerAsset === "USDC" && entry.id !== "R6",
    )) {
      expect(decimalsFor(route)).toBe(6);
    }
  });

  it("splits nep141 from nep245 token ids", () => {
    expect(tokenStandard(getRoute("R1").originAssetId)).toBe("nep141");
    expect(isNep141(getRoute("R1").originAssetId)).toBe(true);
    for (const id of ["R5", "R6"]) {
      expect(tokenStandard(getRoute(id).originAssetId)).toBe("nep141");
      expect(isNep141(getRoute(id).originAssetId)).toBe(true);
    }
    for (const id of ["R4", "R12"]) {
      expect(tokenStandard(getRoute(id).originAssetId)).toBe("nep245");
      expect(isNep245(getRoute(id).originAssetId)).toBe(true);
    }
  });

  it("exposes a settlement asset that is on the allow-list", () => {
    const settlement = defaultSettlementAsset();
    expect(settlement).toContain("nep141:");
    expect(settlementAssets()).toContain(settlement);
  });
});

describe("amount helpers", () => {
  it("converts USD to base units exactly", () => {
    expect(usdToBaseUnits(1, 6)).toBe(1_000_000n);
    expect(usdToBaseUnits(0.01, 6)).toBe(10_000n);
    expect(usdToBaseUnits(1, 18)).toBe(10n ** 18n);
  });

  it("uses the origin decimals for FLEX_INPUT and six decimals for EXACT_OUTPUT", () => {
    expect(quoteAmount(getRoute("R1"), 1)).toBe(1_000_000n);
    expect(quoteAmount(getRoute("R6"), 1)).toBe(10n ** 18n);
    expect(quoteAmount(getRoute("R9"), 1)).toBe(1_000_000n);
  });
});
