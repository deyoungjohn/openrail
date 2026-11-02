/**
 * The only contract methods the watcher may call (blueprint 1.6, 2.9).
 * Names and kinds are checked against `abi/openrail.core.json` in `methods.test.ts`.
 */
export const WATCHER_METHODS = {
  reconcile: "reconcile",
  retryDistribution: "retry_distribution",
  clearStaleLock: "clear_stale_lock",
} as const;

export type WatcherMethod = (typeof WATCHER_METHODS)[keyof typeof WATCHER_METHODS];

export const WATCHER_METHOD_LIST: WatcherMethod[] = [
  WATCHER_METHODS.reconcile,
  WATCHER_METHODS.retryDistribution,
  WATCHER_METHODS.clearStaleLock,
];

/** Blueprint 1.5 rule 5: reconcile is sent with 250 Tgas. */
export const WATCHER_GAS = {
  reconcile: 250_000_000_000_000n,
  retryDistribution: 100_000_000_000_000n,
  clearStaleLock: 50_000_000_000_000n,
} as const;
