"use client";

import { useCallback, useEffect, useState } from "react";
import { readBalance, type Balance } from "./balance";
import type { Async } from "./use-async";

const EVERY_MS = 60_000;

/**
 * The business's balance on `intents.near`, read again every minute while the tab is in view and at once when it comes
 * back into view. A hidden tab reads nothing (each read is an RPC call on the server, and the week's budget is fixed).
 */
export function useBalance(accountId: string | null): [Async<Balance>, () => void] {
  const [value, setValue] = useState<Async<Balance>>({ state: "loading" });
  const read = useCallback(async () => {
    if (accountId === null) return;
    try {
      const data = await readBalance();
      setValue({ state: "ready", data });
    } catch (error) {
      setValue((v) => (v.state === "ready" ? v : { state: "error", error }));
    }
  }, [accountId]);
  useEffect(() => {
    void read();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, EVERY_MS);
    const onShow = () => document.visibilityState === "visible" && void read();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [read]);
  return [value, () => void read()];
}
