import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyPair } from "near-api-js";
import { NearClient, NearQuotaError, NearRpcError } from "./index.js";

const BLOCK_HASH = "1".repeat(32);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rpcResult(result: unknown, id = 1): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function bytesOf(value: unknown): number[] {
  return Array.from(new TextEncoder().encode(JSON.stringify(value)));
}

function callResult(value: unknown): Response {
  return rpcResult({ result: bytesOf(value), logs: [], block_height: 1, block_hash: BLOCK_HASH });
}

afterEach(() => {
  delete process.env.OPENRAIL_NEAR_TEST_ACCOUNT;
  delete process.env.OPENRAIL_NEAR_TEST_KEY;
  vi.restoreAllMocks();
});

describe("near client account balance", () => {
  it("reads an account's balance and moves to the next RPC when one is out of quota (the payout worker read 0 NEAR from a spent first RPC: 11 Nov)", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("primary")
        ? jsonResponse({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32003, message: "daily request limit reached" },
          })
        : rpcResult({ amount: "1000000000000000000000000", block_height: 1 }),
    );
    const client = new NearClient({
      rpcUrls: ["https://rpc.primary", "https://rpc.second"],
      fetchImpl: fetchImpl as never,
    });
    expect(await client.accountBalanceYocto("payout.openrail.near")).toBe(
      1_000_000_000_000_000_000_000_000n,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws when no RPC can tell, instead of answering 0", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32003, message: "daily request limit reached" },
      }),
    );
    const client = new NearClient({
      rpcUrls: ["https://rpc.primary", "https://rpc.second"],
      fetchImpl: fetchImpl as never,
    });
    await expect(client.accountBalanceYocto("payout.openrail.near")).rejects.toBeInstanceOf(
      NearQuotaError,
    );
  });

  it("throws when the answer has no amount", async () => {
    const fetchImpl = vi.fn(async () => rpcResult({ block_height: 1 }));
    const client = new NearClient({
      rpcUrls: ["https://rpc.primary"],
      fetchImpl: fetchImpl as never,
    });
    await expect(client.accountBalanceYocto("nobody.near")).rejects.toBeInstanceOf(NearRpcError);
  });
});

describe("near client views", () => {
  it("decodes a view call and counts the call per feature", async () => {
    const fetchImpl = vi.fn(async () => callResult({ balance: "10" }));
    const client = new NearClient({ rpcUrls: ["https://rpc.primary"], fetchImpl });

    const value = await client.view<{ balance: string }>({
      contractId: "intents.near",
      methodName: "mt_balance_of",
      args: { account_id: "inv.test.near", token_id: "nep141:usdc" },
      feature: "watcher",
    });

    expect(value).toEqual({ balance: "10" });
    expect(client.callCounts()).toEqual({ watcher: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns a batched mt_batch_balance_of result", async () => {
    const fetchImpl = vi.fn(async () => callResult(["1000000", "0", "42"]));
    const client = new NearClient({ rpcUrls: ["https://rpc.primary"], fetchImpl });

    const balances = await client.batchBalanceOf({
      accountId: "inv.test.near",
      tokenIds: ["nep141:a", "nep141:b", "nep245:c"],
      feature: "watcher",
    });

    expect(balances).toEqual(["1000000", "0", "42"]);
    expect(client.callCounts()).toEqual({ watcher: 1 });
  });
});

describe("near client transaction status", () => {
  const status = (result: unknown) => vi.fn(async () => rpcResult(result));

  it("reads a successful transaction", async () => {
    const fetchImpl = status({ final_execution_status: "FINAL", status: { SuccessValue: "" } });
    const client = new NearClient({ rpcUrls: ["https://rpc.primary"], fetchImpl });
    await expect(client.txStatus("HASH", "acme.near")).resolves.toBe("success");
    const body = JSON.parse(
      String(
        (fetchImpl.mock.calls[0] as unknown[])[1]
          ? ((fetchImpl.mock.calls[0] as unknown[])[1] as { body: string }).body
          : "{}",
      ),
    );
    expect(body.method).toBe("tx");
    expect(body.params).toEqual(["HASH", "acme.near"]);
  });

  it("reads a failed transaction", async () => {
    const fetchImpl = status({ status: { Failure: { ActionError: {} } } });
    const client = new NearClient({ rpcUrls: ["https://rpc.primary"], fetchImpl });
    await expect(client.txStatus("HASH", "acme.near")).resolves.toBe("failed");
  });

  it("calls a transaction the node does not know yet pending", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { cause: { name: "UNKNOWN_TRANSACTION" }, message: "Server error" },
      }),
    );
    const client = new NearClient({ rpcUrls: ["https://rpc.primary"], fetchImpl });
    await expect(client.txStatus("HASH", "acme.near")).resolves.toBe("pending");
  });
});

describe("near client cycles through its RPCs", () => {
  it("goes to the next RPC at once on a failure, without trying one twice", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("one"))
        return jsonResponse({ error: { message: "daily request limit reached" } }, 429);
      if (url.includes("two")) return jsonResponse({ error: "unavailable" }, 503);
      return callResult({ ok: true });
    });
    const sleep = vi.fn(async () => undefined);
    const client = new NearClient({
      rpcUrls: ["https://rpc.one", "https://rpc.two", "https://rpc.three"],
      fetchImpl,
      sleep,
      maxRetries: 2,
    });
    await expect(
      client.view({ contractId: "intents.near", methodName: "mt_balance_of", feature: "api" }),
    ).resolves.toEqual({ ok: true });
    expect(urls).toEqual(["https://rpc.one", "https://rpc.two", "https://rpc.three"]);
    expect(sleep).not.toHaveBeenCalled();
    expect(client.fallbackCount()).toBe(2);
  });

  it("starts the next call at the RPC that answered, and comes back round to the first", async () => {
    const urls: string[] = [];
    const oneDown = true;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("one") && oneDown) return jsonResponse({ error: "limit" }, 429);
      return callResult({ ok: true });
    });
    const client = new NearClient({
      rpcUrls: ["https://rpc.one", "https://rpc.two", "https://rpc.three"],
      fetchImpl,
    });
    const call = () =>
      client.view({ contractId: "intents.near", methodName: "mt_balance_of", feature: "api" });
    await call();
    expect(urls).toEqual(["https://rpc.one", "https://rpc.two"]);
    urls.length = 0;
    await call(); // sticks to the one that worked
    expect(urls).toEqual(["https://rpc.two"]);
    // The one that worked now fails: on to the third, and round to the first when that fails too.
    fetchImpl.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("two") || url.includes("three"))
        return jsonResponse({ error: "limit" }, 429);
      return callResult({ ok: true });
    });
    urls.length = 0;
    await call();
    expect(urls).toEqual(["https://rpc.two", "https://rpc.three", "https://rpc.one"]);
  });

  it("with a single RPC still retries a transient error", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ error: "unavailable" }, 503) : callResult({ ok: true });
    });
    const client = new NearClient({
      rpcUrls: ["https://rpc.only"],
      fetchImpl,
      sleep: async () => undefined,
      maxRetries: 1,
    });
    await expect(
      client.view({ contractId: "intents.near", methodName: "mt_balance_of", feature: "api" }),
    ).resolves.toEqual({ ok: true });
  });

  it("never has more than maxConcurrent requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return callResult({ ok: true });
    });
    const client = new NearClient({
      rpcUrls: ["https://rpc.primary"],
      fetchImpl,
      maxConcurrent: 2,
    });
    await Promise.all(
      Array.from({ length: 8 }, () =>
        client.view({ contractId: "intents.near", methodName: "mt_balance_of", feature: "api" }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("near client retry and failover", () => {
  it("fails over to the second RPC on a quota error and never reads it as rejected", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("primary")) {
        return jsonResponse({ error: { cause: { name: "QUOTA_EXCEEDED" } } }, 429);
      }
      return callResult({ ok: true });
    });
    const client = new NearClient({
      rpcUrls: ["https://rpc.primary", "https://rpc.secondary"],
      fetchImpl,
      maxRetries: 0,
    });

    await expect(
      client.view({ contractId: "intents.near", methodName: "mt_balance_of", feature: "quote" }),
    ).resolves.toEqual({ ok: true });

    expect(urls).toEqual(["https://rpc.primary", "https://rpc.secondary"]);
    expect(client.fallbackCount()).toBe(1);
    expect(client.callCounts()).toEqual({ quote: 2 });
  });

  it("throws NearQuotaError when every RPC is over quota", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "daily request limit exceeded" } }, 429),
    );
    const client = new NearClient({
      rpcUrls: ["https://rpc.primary", "https://rpc.secondary"],
      fetchImpl,
      maxRetries: 0,
    });

    const error = await client
      .view({ contractId: "intents.near", methodName: "mt_balance_of", feature: "watcher" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NearQuotaError);
    expect((error as Error).message.toLowerCase()).toContain("quota");
    expect((error as Error).message.toLowerCase()).not.toContain("rejected");
  });

  it("retries a transient error with backoff", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: "unavailable" }, 503);
      return callResult({ ok: true });
    });
    const sleep = vi.fn(async () => undefined);
    const client = new NearClient({
      rpcUrls: ["https://rpc.primary"],
      fetchImpl,
      sleep,
      maxRetries: 1,
      retryBackoffMs: 25,
    });

    await expect(
      client.view({ contractId: "intents.near", methodName: "mt_balance_of", feature: "watcher" }),
    ).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
    expect(client.callCounts()).toEqual({ watcher: 2 });
  });

  it("does not fail over on a non-quota RPC error", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("secondary")) return callResult({ ok: true });
      return jsonResponse({ error: { code: -32000, message: "Method not found" } }, 200);
    });
    const client = new NearClient({
      rpcUrls: ["https://rpc.primary", "https://rpc.secondary"],
      fetchImpl,
      maxRetries: 0,
    });

    await expect(
      client.view({ contractId: "intents.near", methodName: "nope", feature: "watcher" }),
    ).rejects.toBeInstanceOf(NearRpcError);
    expect(client.fallbackCount()).toBe(0);
  });
});

describe("near client signing", () => {
  it("signs a function-call transaction with the key from env", async () => {
    const keyPair = KeyPair.fromRandom("ed25519");
    process.env.OPENRAIL_NEAR_TEST_ACCOUNT = "issuer.test.near";
    process.env.OPENRAIL_NEAR_TEST_KEY = keyPair.toString();

    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method: string;
        params: { request_type?: string };
      };
      if (body.method === "block") return rpcResult({ header: { hash: BLOCK_HASH } });
      if (body.params.request_type === "view_access_key") {
        return rpcResult({ nonce: 7, block_hash: BLOCK_HASH, block_height: 1 });
      }
      return rpcResult({ ok: true });
    });

    const client = new NearClient({
      rpcUrls: ["https://rpc.primary"],
      fetchImpl,
      signer: {
        accountIdEnv: "OPENRAIL_NEAR_TEST_ACCOUNT",
        privateKeyEnv: "OPENRAIL_NEAR_TEST_KEY",
      },
    });

    const signed = await client.signFunctionCall({
      receiverId: "openrail.near",
      methodName: "issue_for",
      args: { claim_id: "1" },
      gas: 100_000_000_000_000n,
      deposit: 0n,
      feature: "issuer",
    });

    expect(signed.signedTxBase64.length).toBeGreaterThan(0);
    expect(signed.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(client.callCounts()).toEqual({ issuer: 2 });
  });
});
