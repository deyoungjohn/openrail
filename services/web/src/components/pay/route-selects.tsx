"use client";

import type { Route } from "@openrail/api-client";
import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { chainOfRoute } from "@/lib/pay";
import { CHAINS, ChainIcon, CoinIcon } from "../ui/chain-badge";
import { Select } from "../ui/input";

/**
 * Two selects that go together: first the token (USDC, ETH, SOL), then the network it is sent on. A token with one
 * network (SOL) needs no second select and is picked at once.
 */
export function RouteSelects({
  routes,
  routeId,
  onPick,
}: {
  routes: Route[];
  routeId: string | null;
  onPick: (id: string) => void;
}) {
  const p = copy.pay;
  const order = ["USDC", "USDT", "NEAR", "ETH", "SOL"];
  const rank = (list: string[], v: string) => (list.indexOf(v) + 99) % 99;
  const assets = [...new Set(routes.map((r) => r.payer_asset))].sort(
    (a, b) => rank(order, a) - rank(order, b),
  );
  const current = routes.find((r) => r.id === routeId) ?? null;
  // USDC is chosen first (NEAR as its network, below): the default everywhere is NEAR (human, 13 Nov).
  const [asset, setAsset] = useState<string>(
    current?.payer_asset ?? (assets.includes("USDC") ? "USDC" : (assets[0] ?? "")),
  );
  const chainOrder = [
    "near",
    "base",
    "arbitrum",
    "solana",
    "ethereum",
    "optimism",
    "polygon",
    "bnb",
  ];
  const chains = routes
    .filter((r) => r.payer_asset === asset)
    .sort((a, b) => rank(chainOrder, a.origin_chain) - rank(chainOrder, b.origin_chain));
  const nearRoute = chains.find((r) => r.origin_chain === "near") ?? null;
  useEffect(() => {
    // Nothing chosen yet: NEAR is preselected.
    if (routeId === null && nearRoute !== null) onPick(nearRoute.id);
  }, [routeId, nearRoute, onPick]);
  const onlyOne = chains.length === 1 ? (chains[0] as Route) : null;
  useEffect(() => {
    if (onlyOne && routeId !== onlyOne.id) onPick(onlyOne.id);
  }, [onlyOne, routeId, onPick]);
  return (
    <div className="grid gap-x-4 sm:grid-cols-2">
      <Select
        label={p.payWith}
        value={asset}
        onValueChange={(a) => {
          setAsset(a);
          // Changing the token clears the network, so a route of another token is never kept by mistake.
          if (current && current.payer_asset !== a) onPick("");
        }}
      >
        {assets.map((a) => (
          <option key={a} value={a} data-icon={<CoinIcon asset={a} />}>
            {a}
          </option>
        ))}
      </Select>
      {asset && chains.length > 1 ? (
        <Select
          label={p.network}
          value={current && current.payer_asset === asset ? current.id : ""}
          onValueChange={onPick}
        >
          {chains.map((r) => (
            <option
              key={r.id}
              value={r.id}
              data-icon={<ChainIcon chain={chainOfRoute(r) ?? "base"} />}
            >
              {CHAINS[chainOfRoute(r) ?? "base"]}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}
