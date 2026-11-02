/**
 * Indexer entry point (blueprint 1.6, 2.9). Binds 127.0.0.1 and serves history, statements,
 * receipts and health for the API and the receipts page.
 *
 * Environment:
 *   NEAR_ROOT_ACCOUNT, NEAR_RPC_URL, NEAR_RPC_URL_FALLBACK
 *   INDEXER_DB_PATH (required), INDEXER_START_HEIGHT (0), INDEXER_POLL_INTERVAL_MS (5000),
 *   INDEXER_BATCH_BLOCKS (100), INDEXER_RETENTION_DAYS (30), INDEXER_PORT (8788)
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
import { ContractClaimReader } from "./claim.js";
import { createIndexerApp } from "./http.js";
import { Indexer } from "./indexer.js";
import { EvmOriginVerifier, OneClickReceiptEnricher, StatusAmountVerifier } from "./receipt.js";
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
  const source = new RpcEventSource(rootAccount, rpcUrls);
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
    ...(sink === undefined ? {} : { sink }),
    ...(enricher === undefined ? {} : { enricher }),
    startHeight: Math.floor(numberEnv("INDEXER_START_HEIGHT", 0)),
    batchBlocks: Math.floor(numberEnv("INDEXER_BATCH_BLOCKS", 100)),
    pollIntervalMs: Math.floor(numberEnv("INDEXER_POLL_INTERVAL_MS", 5_000)),
    retentionDays: Math.floor(numberEnv("INDEXER_RETENTION_DAYS", 30)),
    logger,
  });
  const app = createIndexerApp({ store, indexer, claimReader, rootAccount });

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const result = await app.handle(request.method ?? "GET", request.url ?? "/");
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
