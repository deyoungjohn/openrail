/**
 * Small read-only JSON-RPC helpers for the two values the shared near client does not expose:
 * the final block height (health + lock expiry) and the watcher account balance (alert).
 * Contract calls still go through `@openrail/shared`'s `NearClient`.
 */
import { nearRpcUrlsFromEnv, rpcOrder, rpcWorked } from "@openrail/shared";
import type { ChainStatus } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function nearRpcUrls(): string[] {
  return nearRpcUrlsFromEnv();
}

export class RpcChainStatus implements ChainStatus {
  private readonly urls: string[];
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    urls: string[],
    fetchImpl: FetchLike = (input, init) => fetch(input, init),
    timeoutMs = 15_000,
  ) {
    if (urls.length === 0) throw new Error("NEAR_RPC_INVALID: at least one RPC URL");
    this.urls = urls;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    let lastError: Error | undefined;
    for (const url of rpcOrder(this.urls)) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          lastError = new Error(`RPC_HTTP_${response.status}`);
          continue;
        }
        const body = (await response.json()) as { result?: T; error?: unknown };
        if (body.error !== undefined) {
          lastError = new Error(`RPC_ERROR: ${JSON.stringify(body.error)}`);
          continue;
        }
        if (body.result === undefined) {
          lastError = new Error("RPC_RESULT_MISSING");
          continue;
        }
        rpcWorked(this.urls, url);
        return body.result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error("RPC_UNAVAILABLE");
  }

  async blockHeight(): Promise<number> {
    const result = await this.rpc<{ header?: { height?: number } }>("block", {
      finality: "final",
    });
    const height = result.header?.height;
    if (typeof height !== "number") throw new Error("RPC_INVALID_RESULT: block height");
    return height;
  }

  async accountBalanceYocto(accountId: string): Promise<bigint> {
    const result = await this.rpc<{ amount?: string }>("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    if (typeof result.amount !== "string") {
      throw new Error("RPC_INVALID_RESULT: account balance");
    }
    return BigInt(result.amount);
  }
}
