import { getEnv, requireEnv } from "@openrail/shared";

export const DEFAULT_FAST_INTERVAL_MS = 15_000;
export const DEFAULT_SLOW_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_QUOTE_TTL_MS = 72 * 60 * 60_000;
export const DEFAULT_MIN_BALANCE_NEAR = 0.5;
export const DEFAULT_HEALTH_PORT = 8080;
/** A claim whose last quote is at most this far past its deadline is "hot": the 15 s cadence. */
export const DEFAULT_HOT_WINDOW_MS = 60 * 60_000;
/** Then "warm" (one read a minute) until this long past the deadline, then "cool" until the quote TTL. */
export const DEFAULT_WARM_WINDOW_MS = 24 * 60 * 60_000;
export const DEFAULT_WARM_INTERVAL_MS = 60_000;
export const DEFAULT_COOL_INTERVAL_MS = 5 * 60_000;
/** A claim nobody has asked a price for: looked at this often for a first quote. */
export const DEFAULT_IDLE_PROBE_MS = 60_000;
export const DEFAULT_BALANCE_CHECK_MS = 10 * 60_000;
export const DEFAULT_BLOCK_CACHE_MS = 60_000;
export const DEFAULT_DISCOVER_CACHE_MS = 60_000;

export interface WatcherConfig {
  /** `<root>` contract account. */
  rootAccount: string;
  /** Watcher account (holds the function-call key). */
  watcherAccount: string;
  /** 15 s cadence for hot claims. */
  fastIntervalMs: number;
  /** 10 min cadence after the last quote +72 h. */
  slowIntervalMs: number;
  /** Blueprint 2.9: a quote expires 72 h after its requested deadline. */
  quoteTtlMs: number;
  /** Blueprint 1.5 rule 5: alert below 0.5 NEAR. */
  minBalanceNear: number;
  /** Optional extra token ids (claims issued permissionlessly by non-allow-listed issuers). */
  extraClaims: string[];
  healthPort: number;
  /** SQLite path for the watcher's claim state; empty/absent keeps it in memory. */
  dbPath?: string;
  /**
   * Cadence tuning (11 Nov: the 15 s loop read every open claim three times a tick and used 7.6M QuickNode credits in
   * three days). Optional: the defaults above apply when a field is missing.
   */
  hotWindowMs?: number;
  warmWindowMs?: number;
  warmIntervalMs?: number;
  coolIntervalMs?: number;
  idleProbeMs?: number;
  balanceCheckMs?: number;
  blockCacheMs?: number;
  discoverCacheMs?: number;
}

function numberEnv(name: string, fallback: number): number {
  const raw = getEnv(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`ENV_INVALID: ${name}`);
  }
  return value;
}

/** Reads and validates the watcher environment. Never reads a secret value into logs. */
export function watcherConfigFromEnv(): WatcherConfig {
  return {
    rootAccount: requireEnv("NEAR_ROOT_ACCOUNT"),
    watcherAccount: requireEnv("WATCHER_ACCOUNT_ID"),
    fastIntervalMs: numberEnv("WATCHER_POLL_INTERVAL_MS", DEFAULT_FAST_INTERVAL_MS),
    slowIntervalMs: numberEnv("WATCHER_SLOW_INTERVAL_MS", DEFAULT_SLOW_INTERVAL_MS),
    quoteTtlMs: numberEnv("WATCHER_QUOTE_TTL_MS", DEFAULT_QUOTE_TTL_MS),
    minBalanceNear: numberEnv("WATCHER_MIN_BALANCE_NEAR", DEFAULT_MIN_BALANCE_NEAR),
    extraClaims: (getEnv("WATCHER_EXTRA_CLAIMS") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== ""),
    healthPort: numberEnv("WATCHER_HEALTH_PORT", DEFAULT_HEALTH_PORT),
    dbPath: getEnv("WATCHER_DB_PATH") ?? "/var/lib/openrail/watcher.sqlite",
    hotWindowMs: numberEnv("WATCHER_HOT_WINDOW_MS", DEFAULT_HOT_WINDOW_MS),
    warmWindowMs: numberEnv("WATCHER_WARM_WINDOW_MS", DEFAULT_WARM_WINDOW_MS),
    warmIntervalMs: numberEnv("WATCHER_WARM_INTERVAL_MS", DEFAULT_WARM_INTERVAL_MS),
    coolIntervalMs: numberEnv("WATCHER_COOL_INTERVAL_MS", DEFAULT_COOL_INTERVAL_MS),
    idleProbeMs: numberEnv("WATCHER_IDLE_PROBE_MS", DEFAULT_IDLE_PROBE_MS),
    balanceCheckMs: numberEnv("WATCHER_BALANCE_CHECK_MS", DEFAULT_BALANCE_CHECK_MS),
    blockCacheMs: numberEnv("WATCHER_BLOCK_CACHE_MS", DEFAULT_BLOCK_CACHE_MS),
    discoverCacheMs: numberEnv("WATCHER_DISCOVER_CACHE_MS", DEFAULT_DISCOVER_CACHE_MS),
  };
}
