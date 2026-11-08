/** Production wiring for S1b. Keys live in the issuer service; this process has none. */
import {
  createLogger,
  createOneClickClientFromEnv,
  defaultSettlementAsset,
  getEnv,
  loadRoutes,
  type NearClient,
  nearClientFromEnv,
  OneClickRequestError,
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
import { AuthStore, implicitKeyMatches } from "./auth.js";
import { IdempotencyStore } from "./idempotency.js";
import { loadSpec } from "./mock.js";
import type { QuoteProvider } from "./quote.js";
import { createHttpIndexer } from "./indexer-client.js";
import { createSqliteStores } from "./stores.js";
import { WebhookWorker } from "./webhook-worker.js";
import { RecurringScheduler } from "./recurring.js";
import { expandEvents } from "./modules.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function rpc<T>(
  url: string,
  method: string,
  params: unknown,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000), // a slow node must hand over to the fallback, not hang the sign-in
  });
  const body = (await response.json()) as {
    result?: T;
    error?: { message?: string; cause?: { name?: string } };
  };
  if (!response.ok || body.error !== undefined) {
    throw Object.assign(new Error(`NEAR_RPC_ERROR: ${body.error?.message ?? response.status}`), {
      causeName: body.error?.cause?.name,
    });
  }
  return body.result as T;
}

/**
 * Does `publicKey` belong to `accountId`? A key the chain lists: yes. A key it does not list: no.
 * An implicit account that has never been funded does not exist on chain yet; its own key is accepted
 * then (see implicitKeyMatches). A failing chain read is a 503, never a silent "no".
 */
/** The chain answered "no": the key or account is not there, or what we sent is not a valid account or key. */
function isDefinite(name: string | undefined): boolean {
  return (
    name === "UNKNOWN_ACCESS_KEY" ||
    name === "UNKNOWN_ACCOUNT" ||
    name === "INVALID_ACCOUNT" ||
    name === "PARSE_ERROR" ||
    name === "REQUEST_VALIDATION_ERROR"
  );
}

export function createAccessKeyPort(
  rpcUrl: string | readonly string[],
  fetchImpl?: FetchLike,
  log: (line: string) => void = (line) => console.error(line),
): AccessKeyPort {
  const urls = typeof rpcUrl === "string" ? [rpcUrl] : [...rpcUrl];
  /** The chain's answer from the first RPC that gives one; an RPC that fails is skipped (and logged). */
  const ask = async <T>(params: unknown): Promise<T> => {
    let last: unknown;
    for (const url of urls) {
      try {
        return await rpc<T>(url, "query", params, fetchImpl);
      } catch (error) {
        // A definite answer from the chain (the key or the account is not there) is not a failure.
        const name = (error as { causeName?: string }).causeName;
        if (isDefinite(name)) throw error;
        log(`access key check: ${new URL(url).host} failed: ${(error as Error).message}`);
        last = error;
      }
    }
    throw last ?? new Error("NEAR_RPC_ERROR: no rpc url");
  };
  return {
    async has(accountId, publicKey) {
      try {
        const result = await ask<{ nonce?: number }>({
          request_type: "view_access_key",
          finality: "final",
          account_id: accountId,
          public_key: publicKey,
        });
        if (result.nonce !== undefined) return true;
        // "access key ... does not exist": is the account itself missing?
        if (!implicitKeyMatches(accountId, publicKey)) return false;
        try {
          await ask({ request_type: "view_account", finality: "final", account_id: accountId });
          return false; // the account exists and this key is not on it
        } catch (error) {
          if ((error as { causeName?: string }).causeName === "UNKNOWN_ACCOUNT") return true;
          throw error;
        }
      } catch (error) {
        const name = (error as { causeName?: string }).causeName;
        if (isDefinite(name)) return false;
        log(`access key check unavailable: ${(error as Error).message}`);
        throw new ApiError(503, "chain_unavailable", "could not check the account key on chain");
      }
    },
  };
}

/**
 * The business's prepaid storage credit, read from the contract on every call (`storage_credit_of`), so a deposit
 * shows as soon as it is on chain. `amount` is the deposit the page suggests (an env default).
 */
export async function storageCreditOf(
  near: Pick<NearClient, "view">,
  rootAccount: string,
  accountId: string,
): Promise<{ balance: string; amount: string }> {
  const value = await near.view<unknown>({
    contractId: rootAccount,
    methodName: "storage_credit_of",
    args: { account_id: accountId },
    feature: "api.storage_credit",
  });
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new ApiError(502, "storage_credit_unreadable");
  return {
    balance: value,
    amount: getEnv("STORAGE_CREDIT_AMOUNT") ?? "100000000000000000000000",
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
    async sponsorStatus(accountId) {
      const status = await near.view<{ pool?: unknown; cap?: unknown; used?: unknown }>({
        contractId: rootAccount,
        methodName: "sponsor_status",
        args: { account_id: accountId },
        feature: "api.sponsor_status",
      });
      return {
        pool: String(status.pool ?? "0"),
        cap: Number(status.cap ?? 0),
        used: Number(status.used ?? 0),
      };
    },
    async storageCredit(accountId) {
      return storageCreditOf(near, rootAccount, accountId);
    },
  };
}

/** The issuer's own error code reaches the caller as an ApiError instead of a bare 500. */
export function issuerFailure(status: number, text: string): ApiError {
  let code = "";
  let message = "";
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // not JSON: the status alone
  }
  if (status === 409 && code === "TOKEN_ID_MISMATCH") {
    return new ApiError(409, "token_id_mismatch", message || "the claim id changed while issuing");
  }
  console.error(`issuer answered HTTP ${status} ${code} ${message}`.trim());
  if (status === 401 || status === 403) {
    return new ApiError(502, "issuer_unauthorized", "the issuer service refused the api's key");
  }
  if (status >= 400 && status < 500) {
    return new ApiError(
      status,
      `issuer_${code.toLowerCase() || "rejected"}`,
      message || code || "rejected",
    );
  }
  return new ApiError(
    502,
    "issuer_unavailable",
    `the issuer service failed${code ? ` (${code})` : ""}`,
  );
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
    if (!response.ok) throw issuerFailure(response.status, text);
    return JSON.parse(text) as T;
  };
  return {
    prepareIssue: (accountId) => post("/issue/prepare", { account_id: accountId }),
    issueFor: (request) => post("/issue", request),
    logQuote: (request) => post("/log_quote", request),
    acknowledgeEvm: (request) => post("/ack/evm", request),
  };
}

/** The swap provider refused or failed: say so (502) instead of an anonymous 500. */
export function providerFailure(error: unknown): never {
  if (error instanceof OneClickRequestError) {
    const rejected = error.status >= 400 && error.status < 500;
    throw new ApiError(
      rejected ? 422 : 502,
      rejected ? "provider_rejected" : "provider_unavailable",
      error.message.slice(0, 300),
    );
  }
  throw error;
}

export function createQuoteProvider(): QuoteProvider {
  const client = createOneClickClientFromEnv();
  return {
    async quote(request) {
      const response = await client
        .quote({
          originAsset: request.originAsset,
          destinationAsset: request.destinationAsset,
          amount: request.amount,
          swapType: request.swapType,
          slippageTolerance: request.slippageTolerance,
          refundTo: request.refundTo,
          recipient: request.recipient,
          recipientType: "INTENTS",
          depositType: "ORIGIN_CHAIN",
          // 1Click rejects a quote without these two (HTTP 400, seen on the first live quote): `dry` false asks
          // for a real deposit address, and the refund goes back to an address on the chain the payer used.
          refundType: "ORIGIN_CHAIN",
          dry: false,
          deadline: request.deadline,
        })
        .catch(providerFailure);
      return {
        quoteId: "",
        depositAddress: response.quote.depositAddress ?? "",
        deadline: response.quote.deadline ?? request.deadline,
        amountIn: response.quote.amountIn ?? request.amount,
        amountOut: response.quote.amountOut ?? request.amount,
        spreadBps: 0,
      };
    },
    async status(depositAddress) {
      const result = await client.status(depositAddress);
      const d = result.swapDetails;
      // 1Click lists transactions as { hash, explorerUrl } objects; the API promises plain hashes.
      const hashes = (list: unknown): string[] | undefined =>
        Array.isArray(list)
          ? list
              .map((h) => (typeof h === "string" ? h : (h as { hash?: unknown } | null)?.hash))
              .filter((h): h is string => typeof h === "string" && h !== "")
          : undefined;
      const origin = hashes(d.originChainTxHashes);
      const destination = hashes(d.destinationChainTxHashes);
      const near = hashes(d.nearTxHashes);
      return {
        status: result.status ?? "PENDING_DEPOSIT",
        ...(d.depositedAmount === undefined ? {} : { depositedAmount: d.depositedAmount }),
        ...(origin === undefined ? {} : { originChainTxHashes: origin }),
        ...(destination === undefined ? {} : { destinationChainTxHashes: destination }),
        ...(near === undefined ? {} : { nearTxHashes: near }),
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
      const response = await client
        .quote({
          originAsset: defaultSettlementAsset(),
          destinationAsset: route.originAssetId,
          amount: request.amount,
          swapType: "EXACT_OUTPUT",
          slippageTolerance: 30,
          // The refund of an Intents deposit goes to an Intents account (the business), never to the payout address.
          refundTo: request.refundTo,
          recipient: request.address,
          recipientType: "DESTINATION_CHAIN",
          depositType: "INTENTS",
          refundType: "INTENTS",
          dry: false,
          deadline,
        })
        .catch(providerFailure);
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
      claimLabels: getEnv("CLAIM_LABELS") === "1",
    },
    store: stores.api,
    recurring: stores.recurring,
    docs: stores.docs,
    auth: new AuthStore(Date.now, 7 * 24 * 60 * 60 * 1000, stores),
    idempotency: new IdempotencyStore(stores.idempotency),
    contract: createContractPort(rootAccount),
    issuer: createHttpIssuer(issuerUrl),
    accessKey: createAccessKeyPort(
      [rpcUrl as string, getEnv("NEAR_RPC_URL_FALLBACK")].filter((u): u is string => !!u),
    ),
    cashout: createCashoutPort(),
    indexer,
    pokeIndexer: async () => {
      await fetch(`${indexerUrl.replace(/\/+$/, "")}/poke`, { method: "POST" });
    },
    quoteProvider: createQuoteProvider(),
    spec: loadSpec(),
  });
  const logger = createLogger("api-webhooks");
  const worker = new WebhookWorker({
    events: indexer,
    store: stores.api,
    logger: (message, data) => logger.info(message, data ?? {}),
    expand: (event) => expandEvents(event, app.modules, app.moduleContext),
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
