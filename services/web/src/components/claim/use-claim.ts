"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Claim } from "@/lib/claim";

export type ClaimLoad =
  | { state: "loading" }
  | { state: "error" }
  | { state: "notfound" }
  | { state: "ready"; claim: Claim };

export function useClaim(tokenId: string): [ClaimLoad, () => void] {
  const [load, setLoad] = useState<ClaimLoad>({ state: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: "loading" });
    api
      .getClaim(tokenId)
      .then((claim) => {
        if (!cancelled) setLoad(claim ? { state: "ready", claim } : { state: "notfound" });
      })
      .catch(() => !cancelled && setLoad({ state: "error" }));
    return () => {
      cancelled = true;
    };
  }, [tokenId, tick]);

  return [load, useCallback(() => setTick((t) => t + 1), [])];
}
