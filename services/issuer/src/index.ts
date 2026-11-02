/**
 * Issuer service entry point. Binds 127.0.0.1 and is only reachable by the API on the same host.
 *
 * Environment:
 *   NEAR_ROOT_ACCOUNT, NEAR_RPC_URL, NEAR_RPC_URL_FALLBACK
 *   ISSUER_SERVICE_KEY                      (API bearer / x-issuer-key)
 *   ISSUER_ACCOUNT_ID + ISSUER_PRIVATE_KEY  (function-call key: issue_for, log_quote)
 *   RELAY_PRIVATE_KEY                       (function-call key: acknowledge_evm only)
 *   ISSUER_PORT (8787), ISSUER_RESERVATION_TTL_MS (60000),
 *   ISSUER_ACCOUNT_WAIT_MS (15000), ISSUER_ACCOUNT_POLL_MS (250)
 */
import { createLogger, getEnv, nearClientFromEnv, requireEnv } from "@openrail/shared";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { IssuerError } from "./errors.js";
import { createIssuerApp } from "./http.js";
import { IssuerService, REQUIRED_ISSUE_DEPOSIT_YOCTO } from "./service.js";
import { RpcAccountChecker, RpcStateReader, nearRpcUrls } from "./state.js";

const MAX_BODY_BYTES = 1_048_576;

function numberEnv(name: string, fallback: number): number {
  const raw = getEnv(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`ENV_INVALID: ${name}`);
  return value;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new IssuerError(413, "payload_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const rootAccount = requireEnv("NEAR_ROOT_ACCOUNT");
  const serviceKey = requireEnv("ISSUER_SERVICE_KEY");
  requireEnv("ISSUER_ACCOUNT_ID");
  requireEnv("ISSUER_PRIVATE_KEY");
  requireEnv("RELAY_PRIVATE_KEY");

  const logger = createLogger("issuer");
  const issuerNear = nearClientFromEnv({
    signer: {
      accountIdEnv: "ISSUER_ACCOUNT_ID",
      privateKeyEnv: "ISSUER_PRIVATE_KEY",
    },
  });
  const relayNear = nearClientFromEnv({
    signer: {
      accountIdEnv: "ISSUER_ACCOUNT_ID",
      privateKeyEnv: "RELAY_PRIVATE_KEY",
    },
  });

  const rpcUrls = nearRpcUrls();
  const service = new IssuerService({
    issuerNear,
    relayNear,
    state: new RpcStateReader(rootAccount, rpcUrls),
    accounts: new RpcAccountChecker(rpcUrls),
    logger,
    config: {
      rootAccount,
      requiredDepositYocto: REQUIRED_ISSUE_DEPOSIT_YOCTO,
      reservationTtlMs: numberEnv("ISSUER_RESERVATION_TTL_MS", 60_000),
      accountWaitMs: numberEnv("ISSUER_ACCOUNT_WAIT_MS", 15_000),
      accountPollMs: numberEnv("ISSUER_ACCOUNT_POLL_MS", 250),
    },
  });
  const app = createIssuerApp({ service, serviceKey, logger });

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const body = await readBody(request);
        const result = await app.handle(
          request.method ?? "GET",
          request.url ?? "/",
          request.headers,
          body,
        );
        respond(response, result.status, result.body);
      } catch (error) {
        if (error instanceof IssuerError) {
          respond(response, error.status, { error: { code: error.code } });
          return;
        }
        logger.error("request failed", error instanceof Error ? error.message : String(error));
        respond(response, 500, { error: { code: "internal_error" } });
      }
    })();
  });

  const port = numberEnv("ISSUER_PORT", 8787);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  logger.info("issuer service started", {
    root: rootAccount,
    account: process.env.ISSUER_ACCOUNT_ID,
    health: `http://127.0.0.1:${port}`,
  });

  const shutdown = (signal: string): void => {
    logger.info("stopping", signal);
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
