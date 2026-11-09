/**
 * Indexer entry point (blueprint 1.6, 2.9). Binds 127.0.0.1 and serves history, statements,
 * receipts and health for the API and the receipts page.
 *
 * Environment:
 *   NEAR_ROOT_ACCOUNT, NEAR_RPC_URL, NEAR_RPC_URL_FALLBACK
 *   INDEXER_DB_PATH (required), INDEXER_SOURCE (nearblocks|rpc; default nearblocks),
 *   NEARBLOCKS_API_URL / NEARBLOCKS_API_KEY (account-scoped source),
 *   NEARBLOCKS_DAILY_BUDGET (380), 7 s minimum spacing,
 *   INDEXER_POLL_INTERVAL_MS (1800000), INDEXER_MAX_PAGES (2), INDEXER_RETENTION_DAYS (30),
 *   INDEXER_PORT (8788), INDEXER_START_HEIGHT (0, RPC scanner only)
 *   INDEXER_WEBHOOK_URL / INDEXER_WEBHOOK_SECRET (optional; indexed events only)
 *   ONECLICK_API_URL / ONECLICK_JWT (optional; receipt origin/NEAR hashes)
 */
import {
  OneClickClient,
  createLogger,
  getEnv,
  nearClientFromEnv,
  requireEnv,
} from "@openrail/shared";
import { createServer, type ServerResponse } from "node:http";
import { BudgetGovernor } from "./budget.js";
import { ContractClaimReader } from "./claim.js";
import { RpcTxStatusReader } from "./tx-status.js";
import { createIndexerApp } from "./http.js";
import { Indexer } from "./indexer.js";
import { EvmOriginVerifier, OneClickReceiptEnricher, StatusAmountVerifier } from "./receipt.js";
import { FallbackEventSource } from "./fallback.js";
import { NearBlocksEventSource } from "./nearblocks.js";
import { repairTimes } from "./time-repair.js";
import { RpcEventSource, nearRpcUrls } from "./source.js";
import { IndexerStore } from "./store.js";
import { HttpEventSink } from "./webhook.js";

function numberEnv(name: string, fallback: number): number {
  const raw = getEnv(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`ENV_INVALID: ${name}`);
  return value;
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

async function main(): Promise<void> {
  const rootAccount = requireEnv("NEAR_ROOT_ACCOUNT");
  const dbPath = requireEnv("INDEXER_DB_PATH");
  const logger = createLogger("indexer");
  const rpcUrls = nearRpcUrls();

  const store = new IndexerStore(dbPath, rootAccount);
  const budget = new BudgetGovernor({
    store,
    dailyBudget: Math.floor(numberEnv("NEARBLOCKS_DAILY_BUDGET", 380)),
    minSpacingMs: 7_000,
    log: (message) => logger.warn(message),
  });
  const sourceKind = (getEnv("INDEXER_SOURCE") ?? "nearblocks").toLowerCase();
  const rpcSource = new RpcEventSource(
    rootAccount,
    rpcUrls,
    Math.floor(numberEnv("INDEXER_START_HEIGHT", 0)),
  );
  const source =
    sourceKind === "rpc"
      ? rpcSource
      : new FallbackEventSource(
          new NearBlocksEventSource(
            rootAccount,
            getEnv("NEARBLOCKS_API_URL") ?? "https://api.nearblocks.io",
            getEnv("NEARBLOCKS_API_KEY") ?? "",
            rpcUrls,
            undefined,
            100,
            5,
            budget,
          ),
          rpcSource,
        );
  // Rows written by the old time bug (1970) get their real block time, now and every ten minutes until none is left.
  const repairRound = (): void => {
    void repairTimes({
      store,
      rpcUrls,
      baseUrl: getEnv("NEARBLOCKS_API_URL") ?? "https://api.nearblocks.io",
      apiKey: getEnv("NEARBLOCKS_API_KEY") ?? "",
      budget,
      log: (message) => logger.warn(message),
    }).then((fixed) => {
      if (fixed > 0) logger.info(`repaired the time of ${fixed} transactions`);
      if (store.badTimeTxs().length > 0) setTimeout(repairRound, 10 * 60_000);
    });
  };
  repairRound();
  const near = nearClientFromEnv();
  const claimReader = new ContractClaimReader(near, rootAccount);

  const oneClickUrl = getEnv("ONECLICK_API_URL");
  const oneClickKey = getEnv("ONECLICK_JWT");
  const enricher =
    oneClickUrl !== undefined && oneClickKey !== undefined
      ? new OneClickReceiptEnricher(
          (tokenId) => store.latestQuote(tokenId),
          new OneClickClient({ baseUrl: oneClickUrl, apiKey: oneClickKey }),
          getEnv("EVM_RPC_URL") === undefined
            ? new StatusAmountVerifier()
            : new EvmOriginVerifier(getEnv("EVM_RPC_URL") as string),
        )
      : undefined;

  const webhookUrl = getEnv("INDEXER_WEBHOOK_URL");
  const sink =
    webhookUrl === undefined
      ? undefined
      : new HttpEventSink(webhookUrl, getEnv("INDEXER_WEBHOOK_SECRET") ?? "");

  const indexer = new Indexer({
    source,
    store,
    rootAccount,
    txStatus: new RpcTxStatusReader(rpcUrls),
    ...(sink === undefined ? {} : { sink }),
    ...(enricher === undefined ? {} : { enricher }),
    maxPagesPerSync: Math.floor(numberEnv("INDEXER_MAX_PAGES", 2)),
    pollIntervalMs: Math.floor(numberEnv("INDEXER_POLL_INTERVAL_MS", 1_800_000)),
    retentionDays: Math.floor(numberEnv("INDEXER_RETENTION_DAYS", 30)),
    logger,
    budget,
  });
  const app = createIndexerApp({
    store,
    indexer,
    claimReader,
    rootAccount,
    registerTx: (hash, signer) => indexer.registerTx(hash, signer),
  });

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
        let body: unknown;
        if (chunks.length > 0) {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          } catch {
            body = undefined;
          }
        }
        const result = await app.handle(request.method ?? "GET", request.url ?? "/", body);
        respond(response, result.status, result.body);
      } catch (error) {
        logger.error("request failed", error instanceof Error ? error.message : String(error));
        respond(response, 500, { error: { code: "internal_error" } });
      }
    })();
  });

  const port = Math.floor(numberEnv("INDEXER_PORT", 8788));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  logger.info("indexer started", {
    root: rootAccount,
    source: sourceKind,
    db: dbPath,
    health: `http://127.0.0.1:${port}/health`,
  });

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    await indexer.run(controller.signal);
  } finally {
    server.close();
    store.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
