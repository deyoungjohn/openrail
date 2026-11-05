/** Production wiring for S1b. Keys live in the issuer service; this process has none. */
import {
  createLogger,
  createOneClickClientFromEnv,
  defaultSettlementAsset,
  getEnv,
  loadRoutes,
  nearClientFromEnv,
  requireEnv,
} from "@openrail/shared";
import {
  ApiError,
  ApiApp,
  type AccessKeyPort,
  type CashoutPort,
  type ContractPort,
  type IssuerPort,
} from "./app.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AuthStore } from "./auth.js";
import { IdempotencyStore } from "./idempotency.js";
import { loadSpec } from "./mock.js";
import type { QuoteProvider } from "./quote.js";
import { createHttpIndexer } from "./indexer-client.js";
import { createSqliteStores } from "./stores.js";
import { WebhookWorker } from "./webhook-worker.js";
import { RecurringScheduler } from "./recurring.js";

async function rpc<T>(url: string, method: string, params: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (!response.ok || body.error !== undefined) {
    throw new Error(`NEAR_RPC_ERROR: ${body.error?.message ?? response.status}`);
  }
  return body.result as T;
}

export function createAccessKeyPort(rpcUrl: string): AccessKeyPort {
  return {
    async has(accountId, publicKey) {
      try {
        const result = await rpc<{ nonce?: number }>(rpcUrl, "query", {
          request_type: "view_access_key",
          finality: "final",
          account_id: accountId,
          public_key: publicKey,
        });
        return result.nonce !== undefined;
      } catch {
        return false;
      }
    },
  };
}

export function createContractPort(rootAccount: string): ContractPort {
  const near = nearClientFromEnv();
  return {
    async claim(tokenId) {
      const claim = await near.view<Record<string, unknown> | null>({
        contractId: rootAccount,
        methodName: "claim",
        args: { token_id: tokenId },
        feature: "api.claim",
      });
      if (claim === null) throw new ApiError(404, "claim_not_found");
      return claim as Record<string, unknown> & { kind: number };
    },
    async storageCredit() {
      return {
        balance: getEnv("STORAGE_CREDIT_BALANCE") ?? "0",
        amount: getEnv("STORAGE_CREDIT_AMOUNT") ?? "1000000000000000000000000",
      };
    },
  };
}

export function createHttpIssuer(baseUrl: string): IssuerPort {
  const url = baseUrl.replace(/\/+$/, "");
  const key = getEnv("ISSUER_SERVICE_KEY");
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key === undefined ? {} : { authorization: `Bearer ${key}`, "x-issuer-key": key }),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`ISSUER_HTTP_${response.status}: ${text}`);
    return JSON.parse(text) as T;
  };
  return {
    prepareIssue: (accountId) => post("/issue/prepare", { account_id: accountId }),
    issueFor: (request) => post("/issue", request),
    logQuote: (request) => post("/log_quote", request),
    acknowledgeEvm: (request) => post("/ack/evm", request),
  };
}

export function createQuoteProvider(): QuoteProvider {
  const client = createOneClickClientFromEnv();
  return {
    async quote(request) {
      const response = await client.quote({
        originAsset: request.originAsset,
        destinationAsset: request.destinationAsset,
        amount: request.amount,
        swapType: request.swapType,
        slippageTolerance: request.slippageTolerance,
        refundTo: request.refundTo,
        recipient: request.recipient,
        recipientType: "INTENTS",
        depositType: "ORIGIN_CHAIN",
        deadline: request.deadline,
      });
      return {
        quoteId: "",
        depositAddress: response.quote.depositAddress ?? "",
        deadline: response.quote.deadline ?? request.deadline,
        amountIn: response.quote.amountIn ?? request.amount,
        amountOut: response.quote.amountOut ?? request.amount,
        spreadBps: 0,
      };
    },
  };
}

export function createCashoutPort(): CashoutPort {
  const client = createOneClickClientFromEnv();
  const routes = loadRoutes();
  return {
    async quote(request) {
      const route = routes.routes.find((entry) => entry.originChain === request.destinationChain);
      if (route === undefined) throw new ApiError(400, "unsupported_chain");
      const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const response = await client.quote({
        originAsset: defaultSettlementAsset(),
        destinationAsset: route.originAssetId,
        amount: request.amount,
        swapType: "EXACT_OUTPUT",
        slippageTolerance: 30,
        refundTo: request.address,
        recipient: request.address,
        recipientType: "DESTINATION_CHAIN",
        depositType: "INTENTS",
        deadline,
      });
      return {
        amount: request.amount,
        source_asset: defaultSettlementAsset(),
        destination_chain: request.destinationChain,
        destination_address: request.address,
        amount_out: response.quote.amountOut ?? request.amount,
        min_amount_in: response.quote.minAmountIn ?? request.amount,
        route_cost_usd: "0.00",
        deposit_address: response.quote.depositAddress ?? "",
        deposit_type: "INTENTS",
        swap_type: "EXACT_OUTPUT",
        route_id: route.id,
        deadline: response.quote.deadline ?? deadline,
      };
    },
  };
}

export async function createApiAppFromEnv(): Promise<ApiApp> {
  const rootAccount = requireEnv("NEAR_ROOT_ACCOUNT");
  const issuerUrl = requireEnv("ISSUER_URL");
  const indexerUrl = requireEnv("INDEXER_URL");
  const rpcUrl = getEnv("NEAR_RPC_URL");
  if (rpcUrl === undefined) requireEnv("NEAR_RPC_URL");
  const databasePath = (getEnv("DATABASE_URL") ?? "data/openrail.sqlite").replace(/^file:/, "");
  mkdirSync(dirname(databasePath), { recursive: true });
  const stores = createSqliteStores(databasePath);
  const indexer = createHttpIndexer(indexerUrl);
  const app = new ApiApp({
    config: {
      rootAccount,
      recipient: getEnv("API_RECIPIENT") ?? "api.openrail.near",
      payBaseUrl: getEnv("PAY_BASE_URL") ?? "https://pay.openrail.near",
    },
    store: stores.api,
    recurring: stores.recurring,
    auth: new AuthStore(Date.now, 7 * 24 * 60 * 60 * 1000, stores),
    idempotency: new IdempotencyStore(stores.idempotency),
    contract: createContractPort(rootAccount),
    issuer: createHttpIssuer(issuerUrl),
    accessKey: createAccessKeyPort(rpcUrl as string),
    cashout: createCashoutPort(),
    indexer,
    quoteProvider: createQuoteProvider(),
    spec: loadSpec(),
  });
  const logger = createLogger("api-webhooks");
  const worker = new WebhookWorker({
    events: indexer,
    store: stores.api,
    logger: (message, data) => logger.info(message, data ?? {}),
  });
  const timer = setInterval(() => {
    void worker.runOnce().catch((error: unknown) => {
      logger.error("webhook poll failed", error instanceof Error ? error.message : String(error));
    });
  }, 15_000);
  timer.unref();
  const recurringLogger = createLogger("api-recurring");
  const scheduler = new RecurringScheduler({
    store: stores.recurring,
    issue: (accountId, body, recurringId) => app.issueInvoice(accountId, body, { recurringId }),
    logger: (message, data) => recurringLogger.info(message, data ?? {}),
  });
  const recurringTimer = setInterval(() => {
    void scheduler.runOnce().catch((error: unknown) => {
      recurringLogger.error(
        "recurring pass failed",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, 60_000);
  recurringTimer.unref();
  return app;
}
