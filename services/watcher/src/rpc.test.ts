/**
 * Watcher against the real `@openrail/shared` NearClient and a fake JSON-RPC (no network):
 * transient errors are retried with backoff and a quota error fails over to the next RPC.
 */
import { NearClient, createLogger } from "@openrail/shared";
import { KeyPair } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./chain.js";
import type { WatcherConfig } from "./config.js";
import { WATCHER_METHOD_LIST } from "./methods.js";
import type { ChainStatus, ClaimView, Quote } from "./types.js";
import { Watcher } from "./watcher.js";

const ZERO_HASH = "1".repeat(32);
const ASSETS = ["nep141:a", "nep141:b", "nep141:c", "nep141:d"];
const NOW = 1_800_000_000_000;

const CLAIM: ClaimView = {
  token_id: "c-1",
  issuer_id: "issuer.near",
  claim_account: "c-1.openrail.near",
  status: "Issued",
  lock: "None",
  settlement_assets: ASSETS,
  last_seen_balance: Object.fromEntries(ASSETS.map((asset) => [asset, "0"])),
  undistributed: [],
};

const QUOTE: Quote = {
  quote_id: "q-1",
  deposit_address: "deposit",
  deadline_requested: NOW / 1000,
  refund_to: "refund",
  route_id: "base-usdc",
};

const CONFIG: WatcherConfig = {
  rootAccount: "openrail.near",
  watcherAccount: "watcher.test.near",
  fastIntervalMs: 15_000,
  slowIntervalMs: 600_000,
  quoteTtlMs: 72 * 60 * 60 * 1000,
  minBalanceNear: 0.5,
  extraClaims: [],
  healthPort: 0,
};

const chain: ChainStatus = {
  blockHeight: async () => 1_000,
  accountBalanceYocto: async () => 2n * 10n ** 24n,
};

const logger = createLogger("watcher-rpc-test", () => {});

function bytesOf(value: unknown): number[] {
  return Array.from(new TextEncoder().encode(JSON.stringify(value)));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rpcResult(result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id: 1, result });
}

function callResult(value: unknown): Response {
  return rpcResult({ result: bytesOf(value), logs: [], block_height: 1, block_hash: ZERO_HASH });
}

type RpcBody = { method: string; params: unknown };

interface FakeOptions {
  broadcastFailures?: number;
  quotaConfigOnce?: boolean;
}

function makeFetch(options: FakeOptions = {}): {
  fetchImpl: FetchLike;
  broadcasts: string[];
  urls: string[];
} {
  let failures = options.broadcastFailures ?? 0;
  let quota = options.quotaConfigOnce === true;
  const broadcasts: string[] = [];
  const urls: string[] = [];

  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const body = JSON.parse(String(init?.body)) as RpcBody;

    if (body.method === "block") {
      return rpcResult({ header: { height: 1_000, hash: ZERO_HASH } });
    }

    if (body.method === "query") {
      const params = body.params as {
        request_type?: string;
        method_name?: string;
        account_id?: string;
      };
      if (params.request_type === "view_access_key") {
        return rpcResult({ nonce: 1, block_hash: ZERO_HASH });
      }
      if (params.request_type === "view_account") {
        return rpcResult({ amount: (2n * 10n ** 24n).toString() });
      }
      if (params.request_type === "call_function") {
        if (quota && url.includes("primary") && params.method_name === "config") {
          quota = false;
          return jsonResponse({ error: { message: "daily request limit exceeded" } }, 429);
        }
        switch (params.method_name) {
          case "config":
            return callResult({
              settlement_assets: ASSETS,
              issuers: ["issuer.near"],
              quote_writers: ["api.near"],
              issue_paused: false,
            });
          case "claims_by_issuer":
            return callResult([CLAIM]);
          case "payment_log":
            return callResult([QUOTE]);
          case "claim":
            return callResult(CLAIM);
          case "mt_batch_balance_of":
            return callResult(["100", "0", "0", "0"]);
          default:
            return jsonResponse({ error: { message: `unexpected ${params.method_name}` } }, 400);
        }
      }
    }

    if (body.method === "broadcast_tx_commit") {
      if (failures > 0) {
        failures -= 1;
        return jsonResponse({ error: { message: "unavailable" } }, 503);
      }
      broadcasts.push(String((body.params as string[])[0]));
      return rpcResult({ status: { SuccessValue: "" } });
    }

    return jsonResponse({ error: { message: `unexpected ${body.method}` } }, 400);
  }) as FetchLike;

  return { fetchImpl, broadcasts, urls };
}

function methodOf(base64Transaction: string): string {
  const text = Buffer.from(base64Transaction, "base64").toString("latin1");
  for (const method of WATCHER_METHOD_LIST) {
    if (text.includes(method)) return method;
  }
  return "unknown";
}

function makeClient(
  fetchImpl: FetchLike,
  rpcUrls: string[],
  sleeps: number[],
  maxRetries = 2,
): NearClient {
  return new NearClient({
    rpcUrls,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    maxRetries,
    retryBackoffMs: 100,
    signer: {
      accountIdEnv: "OPENRAIL_WATCHER_TEST_ACCOUNT",
      privateKeyEnv: "OPENRAIL_WATCHER_TEST_KEY",
    },
  });
}

function makeWatcher(near: NearClient): Watcher {
  return new Watcher({
    near,
    chain,
    config: CONFIG,
    logger,
    alert: async () => {},
    now: () => NOW,
    sleep: async () => {},
  });
}

beforeEach(() => {
  process.env.OPENRAIL_WATCHER_TEST_ACCOUNT = "watcher.test.near";
  process.env.OPENRAIL_WATCHER_TEST_KEY = KeyPair.fromRandom("ed25519").toString();
});

afterEach(() => {
  delete process.env.OPENRAIL_WATCHER_TEST_ACCOUNT;
  delete process.env.OPENRAIL_WATCHER_TEST_KEY;
  vi.restoreAllMocks();
});

describe("watcher over the shared near client", () => {
  it("retries a failed call with backoff and reconciles once", async () => {
    const { fetchImpl, broadcasts } = makeFetch({ broadcastFailures: 1 });
    const sleeps: number[] = [];
    const near = makeClient(fetchImpl, ["https://rpc.primary"], sleeps, 1);

    const summary = await makeWatcher(near).tick();

    expect(summary.reconciled).toEqual(["c-1"]);
    expect(sleeps).toEqual([100]);
    expect(broadcasts).toHaveLength(1);
    expect(methodOf(broadcasts[0] ?? "")).toBe("reconcile");
  });

  it("fails over to the next RPC on a quota error", async () => {
    const { fetchImpl, broadcasts } = makeFetch({ quotaConfigOnce: true });
    const near = makeClient(fetchImpl, ["https://rpc.primary", "https://rpc.secondary"], [], 0);

    const summary = await makeWatcher(near).tick();

    expect(near.fallbackCount()).toBeGreaterThanOrEqual(1);
    expect(summary.reconciled).toEqual(["c-1"]);
    expect(broadcasts).toHaveLength(1);
    expect(methodOf(broadcasts[0] ?? "")).toBe("reconcile");
  });
});
