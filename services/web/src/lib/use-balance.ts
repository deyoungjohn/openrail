"use client";

import { useCallback, useEffect, useState } from "react";
import { readBalance, type Balance } from "./balance";
import type { Async } from "./use-async";

const EVERY_MS = 15_000;

/** The business's balance on `intents.near`, read again every 15 seconds and when the tab comes back into view. */
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
    const timer = setInterval(() => void read(), EVERY_MS);
    const onShow = () => document.visibilityState === "visible" && void read();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [read]);
  return [value, () => void read()];
}
