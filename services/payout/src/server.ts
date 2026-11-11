/** Entrypoint for the settle payout worker (started only when the settle module is enabled). */
import { readFileSync } from "node:fs";
import { createLogger, getEnv, requireEnv } from "@openrail/shared";
import { CallBudget } from "./budget.js";
import { PayoutChain } from "./chain.js";
import { IndexerHeldDiscovery } from "./discovery.js";
import { HttpPayoutSettings } from "./settings.js";
import { startPayoutHealthServer } from "./health.js";
import { OneClickInPayout } from "./oneclick.js";
import { PayoutWorker } from "./worker.js";

function numberEnv(name: string, fallback: number): number {
  const raw = getEnv(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`ENV_INVALID: ${name}`);
  return value;
}

function settleEnabled(): boolean {
  try {
    const modules = JSON.parse(
      readFileSync(new URL("../../../openrail.modules.json", import.meta.url), "utf8"),
    ) as { modules?: { id?: string; enabled?: boolean }[] };
    return (
      modules.modules?.some((entry) => entry.id === "settle" && entry.enabled === true) ?? false
    );
  } catch {
    return false;
  }
}

class SkipBalance extends Error {}

async function main(): Promise<void> {
  if (!settleEnabled()) return;
  const rootAccount = requireEnv("NEAR_ROOT_ACCOUNT");
  const indexerUrl = requireEnv("INDEXER_URL");
  requireEnv("PAYOUT_RELAYER_PRIVATE_KEY");
  const logger = createLogger("payout");
  const budget = new CallBudget(
    numberEnv("PAYOUT_RPC_DAILY_BUDGET", 380),
    numberEnv("PAYOUT_RPC_MIN_SPACING_MS", 7_000),
  );
  const chain = new PayoutChain({ rootAccount, budget, indexerUrl });
  let lastAlert: string | null = null;
  const worker = new PayoutWorker({
    discovery: new IndexerHeldDiscovery(indexerUrl),
    ...(getEnv("PAYOUT_API_URL") !== undefined && getEnv("PAYOUT_INTERNAL_KEY") !== undefined
      ? { settings: HttpPayoutSettings.fromEnv() }
      : {}),
    chain,
    quote: new OneClickInPayout(),
    status: new OneClickInPayout(),
    logger,
    alert: (message, data) => {
      lastAlert = message;
      logger.error(message, data ?? {});
    },
  });

  let lastTick: string | null = null;
  let lastError: string | null = null;
  let lastSummary: unknown = null;
  let balanceNear: number | null = null;
  const interval = numberEnv("PAYOUT_POLL_INTERVAL_MS", 15_000);
  const minBalance = numberEnv("PAYOUT_MIN_BALANCE_NEAR", 0.5);
  const alertUrl = getEnv("ALERT_WEBHOOK_URL");
  let lowAlerted = false;
  let lastBalanceAt = 0;
  const balanceEveryMs = numberEnv("PAYOUT_BALANCE_CHECK_MS", 600_000);

  const health = await startPayoutHealthServer(numberEnv("PAYOUT_HEALTH_PORT", 8081), () => ({
    ok: lastError === null,
    status: lastError === null ? "ok" : "degraded",
    balance_near: balanceNear,
    last_tick_at: lastTick,
    last_error: lastError,
    last_alert: lastAlert,
    last_summary: lastSummary,
  }));

  const tick = async (): Promise<void> => {
    try {
      lastSummary = await worker.tick();
      lastTick = new Date().toISOString();
      lastError = null;
      // The balance is read apart from the tick: when no RPC can answer, say so and keep the last known value; a failed
      // read is never a zero balance and never raises the low-balance alert (11 Nov: "balance is low 0" with 1 NEAR in it).
      try {
        if (balanceNear !== null && Date.now() - lastBalanceAt < balanceEveryMs)
          throw new SkipBalance();
        lastBalanceAt = Date.now();
        const yocto = await chain.balanceYocto();
        balanceNear = Number(yocto) / 1e24;
        if (balanceNear >= minBalance) lowAlerted = false;
        if (balanceNear < minBalance && !lowAlerted) {
          lowAlerted = true;
          if (alertUrl !== undefined) {
            await fetch(alertUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                service: "payout",
                kind: "low_balance",
                balance_near: balanceNear,
                threshold_near: minBalance,
                at: lastTick,
              }),
            }).catch(() => undefined);
          }
          lastAlert = "relayer balance is low";
          logger.warn("payout relayer balance is low", balanceNear);
        }
      } catch (error) {
        if (error instanceof SkipBalance) {
          // read less than ten minutes ago
        } else
          logger.warn(
            "payout relayer balance could not be read",
            error instanceof Error ? error.message : String(error),
          );
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logger.error("payout tick failed", lastError);
    }
  };

  const timer = setInterval(() => void tick(), interval);
  const controller = new AbortController();
  const stop = (signal: string): void => {
    logger.info("stopping", signal);
    controller.abort();
    clearInterval(timer);
    void health.close();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  logger.info("payout worker started", { root: rootAccount, health: health.url });
  await tick();
  await new Promise<void>((resolve) =>
    controller.signal.addEventListener("abort", () => resolve()),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
