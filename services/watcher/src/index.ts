/**
 * Watcher entry point (blueprint 1.6, 2.9).
 *
 * Environment (secrets via `requireEnv`, never logged):
 *   NEAR_ROOT_ACCOUNT, NEAR_RPC_URL, NEAR_RPC_URL_FALLBACK
 *   WATCHER_ACCOUNT_ID, WATCHER_PRIVATE_KEY  (function-call key: reconcile,
 *     retry_distribution, clear_stale_lock only)
 *   WATCHER_POLL_INTERVAL_MS (15000), WATCHER_SLOW_INTERVAL_MS (600000),
 *   WATCHER_QUOTE_TTL_MS (259200000), WATCHER_MIN_BALANCE_NEAR (0.5),
 *   WATCHER_HEALTH_PORT (8080), WATCHER_EXTRA_CLAIMS (comma-separated token ids),
 *   ALERT_WEBHOOK_URL (optional), NEAR_ENV (mainnet|testnet)
 */
import {
  createIndexerControl,
  createLogger,
  getEnv,
  nearClientFromEnv,
  requireEnv,
  writeReport,
} from "@openrail/shared";
import { webhookAlertSink } from "./alerts.js";
import { RpcChainStatus, nearRpcUrls } from "./chain.js";
import { watcherConfigFromEnv } from "./config.js";
import { startHealthServer } from "./health.js";
import { Watcher } from "./watcher.js";

async function main(): Promise<void> {
  const config = watcherConfigFromEnv();
  // Validated and registered for redaction; the near client reads it again when signing.
  requireEnv("WATCHER_PRIVATE_KEY");

  const logger = createLogger("watcher");
  const near = nearClientFromEnv({
    signer: {
      accountIdEnv: "WATCHER_ACCOUNT_ID",
      privateKeyEnv: "WATCHER_PRIVATE_KEY",
    },
  });
  const chain = new RpcChainStatus(nearRpcUrls());
  const alert = webhookAlertSink(getEnv("ALERT_WEBHOOK_URL"));

  const network = getEnv("NEAR_ENV") === "testnet" ? "testnet" : "mainnet";
  const watcher = new Watcher({
    near,
    chain,
    config,
    logger,
    alert,
    indexer:
      getEnv("INDEXER_URL") === undefined
        ? undefined
        : createIndexerControl(getEnv("INDEXER_URL") as string, config.watcherAccount),
    reportLowBalance: (snapshot) => {
      writeReport({
        test_id: "watcher-low-balance",
        spec_ref: "blueprint 1.5.5, 2.9",
        tier: "service",
        network,
        thresholds: [{ path: "near_balance_near", op: ">=", value: snapshot.min_balance_near }],
        measurements: {
          near_balance_near: snapshot.near_balance_near ?? 0,
          last_block_height: snapshot.last_block_height ?? 0,
        },
        observations: [
          "watcher NEAR balance is below the alert threshold; top up the watcher account",
        ],
      });
    },
  });

  const health = await startHealthServer(
    config.healthPort,
    () => watcher.snapshot(),
    "127.0.0.1",
    (tokenId) => watcher.poke(tokenId),
  );
  logger.info("watcher started", {
    root: config.rootAccount,
    account: config.watcherAccount,
    health: health.url,
    fastIntervalMs: config.fastIntervalMs,
    slowIntervalMs: config.slowIntervalMs,
  });

  const controller = new AbortController();
  const stop = (signal: string): void => {
    logger.info("stopping", signal);
    controller.abort();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  try {
    await watcher.run(controller.signal);
  } finally {
    await health.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
