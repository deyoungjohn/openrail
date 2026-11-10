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
  nearRpcUrlsFromEnv,
  rpcOrder,
  rpcWorked,
} from "@openrail/shared";
import {
  ApiError,
  ApiApp,
  type AccessKeyPort,
  type CashoutPort,
  type ContractPort,
  type IssuerPort,
  type PayoutEstimatorPort,
  type ConfidentialBalancePort,
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
    for (const url of rpcOrder(urls)) {
      try {
        const answer = await rpc<T>(url, "query", params, fetchImpl);
        rpcWorked(urls, url);
        return answer;
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
    async view(methodName, args) {
      return near.view<unknown>({
        contractId: rootAccount,
        methodName,
        args: args as Record<string, unknown>,
        feature: "api.module_view",
      });
    },
    async txStatus(txHash, senderId) {
      return near.txStatus(txHash, senderId);
    },
    async settleHeld(tokenId) {
      const held = await near.view<Record<string, unknown>[]>({
        contractId: rootAccount,
        methodName: "settle_held",
        args: { token_id: tokenId },
        feature: "api.settle_held",
      });
      return Array.isArray(held) ? held : [];
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

/** What a cash-out costs: the amount that leaves minus the amount that arrives, in dollars rounded up to the cent. */
function costInUsd(amountIn: string, amountOut: string | undefined): string {
  if (amountOut === undefined) return "0.00";
  const diff = BigInt(amountIn) - BigInt(amountOut);
  if (diff <= 0n) return "0.00";
  const cents = (diff + 9_999n) / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export function createCashoutPort(
  client: Pick<
    ReturnType<typeof createOneClickClientFromEnv>,
    "quote"
  > = createOneClickClientFromEnv(),
): CashoutPort {
  const routes = loadRoutes();
  return {
    async quote(request) {
      const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      if (request.destinationChain === "confidential") {
        const asset = request.sourceAsset ?? defaultSettlementAsset();
        const response = await client
          .quote({
            originAsset: asset,
            destinationAsset: asset,
            amount: request.amount,
            swapType: "EXACT_INPUT",
            slippageTolerance: 30,
            refundTo: request.refundTo,
            recipient: request.address,
            recipientType: "CONFIDENTIAL_INTENTS",
            depositType: "INTENTS",
            refundType: "INTENTS",
            dry: false,
            deadline,
          })
          .catch(providerFailure);
        return {
          amount: request.amount,
          source_asset: asset,
          destination_chain: "confidential",
          destination_address: request.address,
          amount_out: response.quote.amountOut ?? request.amount,
          min_amount_in: request.amount,
          route_cost_usd: costInUsd(request.amount, response.quote.amountOut),
          deposit_address: response.quote.depositAddress ?? "",
          deposit_type: "INTENTS",
          swap_type: "EXACT_INPUT",
          route_id: "confidential",
          deadline: response.quote.deadline ?? deadline,
        };
      }
      const route = routes.routes.find((entry) => entry.originChain === request.destinationChain);
      if (route === undefined) throw new ApiError(400, "unsupported_chain");
      const response = await client
        .quote({
          originAsset: request.sourceAsset ?? defaultSettlementAsset(),
          destinationAsset: route.originAssetId,
          amount: request.amount,
          // The amount is what leaves the balance; the fees come out of it (never a deposit that falls short).
          swapType: "EXACT_INPUT",
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
        source_asset: request.sourceAsset ?? defaultSettlementAsset(),
        destination_chain: request.destinationChain,
        destination_address: request.address,
        amount_out: response.quote.amountOut ?? request.amount,
        // The whole amount is deposited, so nothing is short of the provider's minimum.
        min_amount_in: request.amount,
        route_cost_usd: costInUsd(request.amount, response.quote.amountOut),
        deposit_address: response.quote.depositAddress ?? "",
        deposit_type: "INTENTS",
        swap_type: "EXACT_INPUT",
        route_id: route.id,
        deadline: response.quote.deadline ?? deadline,
      };
    },
  };
}

const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const PAYOUT_DESTINATIONS: Record<string, { asset: string; address: string }> = {
  base: {
    asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    address: "0x1111222233334444555566667777888899990000",
  },
  arbitrum: {
    asset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    address: "0x1111222233334444555566667777888899990000",
  },
  ethereum: {
    asset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    address: "0x1111222233334444555566667777888899990000",
  },
  solana: {
    asset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    address: "11111111111111111111111111111111",
  },
};

function usdMicro(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = String(value % 1_000_000n).padStart(6, "0");
  return `${whole}.${fraction}`;
}

function createPayoutEstimator(): PayoutEstimatorPort {
  const client = createOneClickClientFromEnv();
  return {
    async estimate(destination) {
      const [chainRaw, addressRaw] = destination.split(":", 2);
      const chain = (chainRaw ?? "").toLowerCase();
      const target = PAYOUT_DESTINATIONS[chain];
      if (target === undefined) throw new ApiError(400, "unsupported_chain");
      const address = addressRaw === undefined || addressRaw === "" ? target.address : addressRaw;
      const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const sizes = [];
      for (const usd of [5, 50, 500]) {
        const amount = String(BigInt(usd) * 1_000_000n);
        const response = await client.quote({
          originAsset: USDC_NEAR,
          destinationAsset: target.asset,
          amount,
          swapType: "EXACT_INPUT",
          depositType: "INTENTS",
          refundTo: address,
          recipient: address,
          recipientType: "DESTINATION_CHAIN",
          refundType: "ORIGIN_CHAIN",
          dry: false,
          slippageTolerance: 100,
          deadline,
        });
        const out =
          typeof response.quote.amountOut === "string" ? BigInt(response.quote.amountOut) : 0n;
        sizes.push({
          amount_usd: `${usd}.00`,
          paid_usd: usdMicro(BigInt(amount)),
          received_usd: usdMicro(out),
          cost_usd: usdMicro(BigInt(amount) - out),
        });
      }
      return { destination, chain, sizes, measured_at: new Date().toISOString() };
    },
  };
}

function confidentialBase(): string {
  return (getEnv("ONECLICK_API_URL") ?? "https://1click.chaindefuser.com").replace(/\/+$/, "");
}

function createConfidentialBalancePort(): ConfidentialBalancePort {
  return {
    async authenticate(signedData) {
      const response = await fetch(`${confidentialBase()}/v0/auth/authenticate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedData }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      if (!response.ok) throw new ApiError(502, "confidential_auth_failed", text.slice(0, 200));
      const body = JSON.parse(text) as { accessToken?: unknown; expiresIn?: unknown };
      if (typeof body.accessToken !== "string" || typeof body.expiresIn !== "number")
        throw new ApiError(502, "confidential_auth_failed");
      return { accessToken: body.accessToken, expiresIn: body.expiresIn };
    },
    async balances(userToken, tokenIds) {
      const query = tokenIds.map(encodeURIComponent).join(",");
      const response = await fetch(`${confidentialBase()}/v0/account/balances?tokenIds=${query}`, {
        headers: { authorization: `Bearer ${userToken}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new ApiError(502, "confidential_balance_failed");
      const body = (await response.json()) as {
        balances?: { tokenId?: unknown; available?: unknown; source?: unknown }[];
      };
      return (body.balances ?? [])
        .filter(
          (entry): entry is { tokenId: string; available: string; source: string } =>
            typeof entry.tokenId === "string" &&
            typeof entry.available === "string" &&
            typeof entry.source === "string",
        )
        .map((entry) => ({
          tokenId: entry.tokenId,
          available: entry.available,
          source: entry.source,
        }));
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
      confidentialIntents: getEnv("CONFIDENTIAL_INTENTS") === "1",
    },
    store: stores.api,
    recurring: stores.recurring,
    docs: stores.docs,
    auth: new AuthStore(Date.now, 7 * 24 * 60 * 60 * 1000, stores),
    idempotency: new IdempotencyStore(stores.idempotency),
    contract: createContractPort(rootAccount),
    issuer: createHttpIssuer(issuerUrl),
    accessKey: createAccessKeyPort(nearRpcUrlsFromEnv()),
    cashout: createCashoutPort(),
    payoutEstimator: createPayoutEstimator(),
    ...(getEnv("CONFIDENTIAL_INTENTS") === "1"
      ? { confidential: createConfidentialBalancePort() }
      : {}),
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
