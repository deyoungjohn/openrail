"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { dashClient } from "./client";
import type { Async } from "./use-async";

type Credit = Awaited<ReturnType<typeof dashClient.business.storageCredit>>;

const EVERY_MS = 10_000;
const AFTER_DEPOSIT_MS = 2_500;
const AFTER_DEPOSIT_TRIES = 16;

/**
 * The prepaid storage credit, kept current: it is read again every 10 seconds and whenever the tab comes back into
 * view, without a loading flash. `reload` reads it now; `watchDeposit` reads it every 2.5 seconds for about 40
 * seconds, or until the balance changes, so a deposit shows as soon as it is on chain.
 */
export function useStorageCredit(): [Async<Credit>, () => void, () => void] {
  const [value, setValue] = useState<Async<Credit>>({ state: "loading" });
  const last = useRef<string | null>(null);
  const alive = useRef(true);

  const read = useCallback(async (): Promise<string | null> => {
    try {
      const data = await dashClient.business.storageCredit();
      if (!alive.current) return null;
      last.current = data.balance;
      setValue({ state: "ready", data });
      return data.balance;
    } catch (error) {
      // A failed refresh keeps what is on screen; only the first read can show the error.
      if (alive.current) setValue((v) => (v.state === "ready" ? v : { state: "error", error }));
      return null;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void read();
    const timer = setInterval(() => void read(), EVERY_MS);
    const onShow = () => document.visibilityState === "visible" && void read();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      alive.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [read]);

  const watchDeposit = useCallback(() => {
    const before = last.current;
    void (async () => {
      for (let i = 0; i < AFTER_DEPOSIT_TRIES && alive.current; i++) {
        await new Promise((r) => setTimeout(r, AFTER_DEPOSIT_MS));
        const now = await read();
        if (now !== null && now !== before) return;
      }
    })();
  }, [read]);

  return [value, () => void read(), watchDeposit];
}
