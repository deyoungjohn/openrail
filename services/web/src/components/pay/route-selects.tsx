"use client";

import type { Route } from "@openrail/api-client";
import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { chainOfRoute } from "@/lib/pay";
import { CHAINS } from "../ui/chain-badge";
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
  const order = ["USDC", "ETH", "SOL"];
  const assets = [...new Set(routes.map((r) => r.payer_asset))].sort(
    (a, b) => ((order.indexOf(a) + 99) % 99) - ((order.indexOf(b) + 99) % 99),
  );
  const current = routes.find((r) => r.id === routeId) ?? null;
  const [asset, setAsset] = useState<string>(current?.payer_asset ?? "");
  const chains = routes.filter((r) => r.payer_asset === asset);
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
          <option key={a} value={a}>
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
            <option key={r.id} value={r.id}>
              {CHAINS[chainOfRoute(r) ?? "base"]}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}
