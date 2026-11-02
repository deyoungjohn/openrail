/**
 * Typed route registry (blueprint 1.5.8, 2.8).
 *
 * `config/routes.json` is the only place token ids live. Data carried over from
 * the spike `data/routes.json`; route probes are in the K2′ part A report.
 */
import { readFileSync } from "node:fs";

export type Chain =
  "base" | "arbitrum" | "ethereum" | "optimism" | "polygon" | "bnb" | "solana" | "near";
export type PayerAsset = "USDC" | "ETH" | "SOL";
export type SwapType = "FLEX_INPUT" | "EXACT_OUTPUT";
export type TokenStandard = "nep141" | "nep245";

export interface Route {
  id: string;
  originChain: Chain;
  payerAsset: PayerAsset;
  originAssetId: string;
  originDecimals: number;
  originContract: string | null;
  swapType: SwapType;
  destinationAssetId: string;
  evmChainId: number | null;
  rpcVar: string | null;
  partB: boolean;
}

export interface RouteFile {
  _comment?: string;
  _source?: string;
  settlementAssets: string[];
  routes: Route[];
  railB: { chains: string[]; excluded: string[] };
}

export class UnknownRouteError extends Error {
  override readonly name = "UnknownRouteError";

  constructor(id: string) {
    super(`UNKNOWN_ROUTE: ${id}`);
  }
}

const DEFAULT_ROUTES_PATH = new URL("../../../../config/routes.json", import.meta.url);
let cached: RouteFile | undefined;

/** Load and validate the route file (default: config/routes.json). */
export function loadRoutes(path: string | URL = DEFAULT_ROUTES_PATH): RouteFile {
  const file = JSON.parse(readFileSync(path, "utf8")) as RouteFile;
  if (!Array.isArray(file.routes) || !Array.isArray(file.settlementAssets)) {
    throw new Error("ROUTES_INVALID: routes and settlementAssets must be arrays");
  }
  const ids = new Set<string>();
  for (const route of file.routes) {
    if (ids.has(route.id)) throw new Error(`ROUTES_INVALID: duplicate route ${route.id}`);
    ids.add(route.id);
    if (route.originDecimals < 0 || !Number.isInteger(route.originDecimals)) {
      throw new Error(`ROUTES_INVALID: bad decimals on ${route.id}`);
    }
    if (tokenStandard(route.originAssetId) === undefined) {
      throw new Error(`ROUTES_INVALID: bad token id on ${route.id}`);
    }
  }
  return file;
}

/** The default route file, cached for the process. */
export function routes(): RouteFile {
  cached ??= loadRoutes();
  return cached;
}

/** Test-only cache reset. */
export function resetRoutesCache(): void {
  cached = undefined;
}

/** Unknown ids throw UnknownRouteError. */
export function getRoute(id: string, file: RouteFile = routes()): Route {
  const route = file.routes.find((entry) => entry.id === id);
  if (route === undefined) throw new UnknownRouteError(id);
  return route;
}

export function allowedRoutes(file: RouteFile = routes()): Route[] {
  return file.routes;
}

export function isAllowedRoute(id: string, file: RouteFile = routes()): boolean {
  return file.routes.some((entry) => entry.id === id);
}

export function assertAllowedRoute(id: string, file: RouteFile = routes()): Route {
  return getRoute(id, file);
}

export function routesForChain(chain: Chain, file: RouteFile = routes()): Route[] {
  return file.routes.filter((route) => route.originChain === chain);
}

/** The origin token id for a chain and payer asset. */
export function tokenIdFor(chain: Chain, asset: PayerAsset, file: RouteFile = routes()): string {
  const route = file.routes.find(
    (entry) => entry.originChain === chain && entry.payerAsset === asset,
  );
  if (route === undefined) throw new UnknownRouteError(`${chain}/${asset}`);
  return route.originAssetId;
}

export function settlementAssets(file: RouteFile = routes()): string[] {
  return file.settlementAssets;
}

/** Default settlement asset is USDC on NEAR (blueprint 2.8). */
export function defaultSettlementAsset(file: RouteFile = routes()): string {
  const first = file.settlementAssets[0];
  if (first === undefined) throw new Error("ROUTES_INVALID: no settlement assets");
  return first;
}

/** nep141 vs nep245 split (blueprint 1.5.8). */
export function tokenStandard(tokenId: string): TokenStandard | undefined {
  if (tokenId.startsWith("nep141:")) return "nep141";
  if (tokenId.startsWith("nep245:")) return "nep245";
  return undefined;
}

export function isNep141(tokenId: string): boolean {
  return tokenStandard(tokenId) === "nep141";
}

export function isNep245(tokenId: string): boolean {
  return tokenStandard(tokenId) === "nep245";
}

/** Origin decimals from a route or a token id. BNB USDC is 18; other USDC is 6. */
export function decimalsFor(routeOrTokenId: Route | string, file: RouteFile = routes()): number {
  if (typeof routeOrTokenId !== "string") return routeOrTokenId.originDecimals;
  const route = file.routes.find(
    (entry) =>
      entry.originAssetId === routeOrTokenId || entry.destinationAssetId === routeOrTokenId,
  );
  if (route === undefined) throw new UnknownRouteError(routeOrTokenId);
  return route.originDecimals;
}

/** Base units of `usd` for an asset with `decimals` decimals (no floating-point drift on the dollar part). */
export function usdToBaseUnits(usd: number, decimals: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("ROUTES_INVALID: usd must be non-negative");
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("ROUTES_INVALID: decimals must be a non-negative integer");
  }
  const cents = BigInt(Math.round(usd * 100));
  return (cents * 10n ** BigInt(decimals)) / 100n;
}

/** Amount to put in the quote: origin base units for FLEX_INPUT, 6-decimal USDC for EXACT_OUTPUT. */
export function quoteAmount(route: Route, usd: number): bigint {
  return route.swapType === "EXACT_OUTPUT"
    ? usdToBaseUnits(usd, 6)
    : usdToBaseUnits(usd, route.originDecimals);
}
