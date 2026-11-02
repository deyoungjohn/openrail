import { getEnv, requireEnv } from "@openrail/shared";

export const DEFAULT_FAST_INTERVAL_MS = 15_000;
export const DEFAULT_SLOW_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_QUOTE_TTL_MS = 72 * 60 * 60_000;
export const DEFAULT_MIN_BALANCE_NEAR = 0.5;
export const DEFAULT_HEALTH_PORT = 8080;

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
  };
}
