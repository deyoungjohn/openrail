"use client";

import { useCallback, useEffect, useState } from "react";

export type Async<T> =
  { state: "loading" } | { state: "error"; error: unknown } | { state: "ready"; data: T };

/** Runs `load` on mount and whenever `deps` change; `retry` runs it again. */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): [Async<T>, () => void] {
  const [value, setValue] = useState<Async<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let off = false;
    setValue({ state: "loading" });
    load().then(
      (data) => !off && setValue({ state: "ready", data }),
      (error: unknown) => !off && setValue({ state: "error", error }),
    );
    return () => {
      off = true;
    };
  }, [...deps, tick]);
  return [value, useCallback(() => setTick((t) => t + 1), [])];
}
