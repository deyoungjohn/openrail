/**
 * Read-only RPC helpers for the two values the public ABI does not expose:
 *   - `next_token_id`, the last Borsh field of the contract state under key `STATE`;
 *   - `storage_credit[business]`, a `LookupMap<AccountId, U128>` under prefix `s:`.
 *
 * All contract calls still go through `@openrail/shared`'s NearClient.
 */
import { getEnv, requireEnv } from "@openrail/shared";
import type { AccountChecker, IssuerStateReader } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const STATE_KEY = "STATE";
const STORAGE_CREDIT_PREFIX = "s:";
const VIEW_STATE_TIMEOUT_MS = 15_000;

export function nearRpcUrls(): string[] {
  const primary = requireEnv("NEAR_RPC_URL");
  const fallback = getEnv("NEAR_RPC_URL_FALLBACK");
  return [...primary.split(","), ...(fallback === undefined ? [] : [fallback])]
    .map((url) => url.trim())
    .filter((url) => url !== "");
}

async function rpc<T>(
  urls: string[],
  fetchImpl: FetchLike,
  method: string,
  params: unknown,
): Promise<T> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(VIEW_STATE_TIMEOUT_MS),
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
      return body.result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("RPC_UNAVAILABLE");
}

/** Borsh `String`/AccountId: u32 little-endian length followed by UTF-8 bytes. */
export function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

interface StateValue {
  key?: string;
  value?: string;
}

export class RpcStateReader implements IssuerStateReader {
  private readonly urls: string[];
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly rootAccount: string,
    urls: string[],
    fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    if (urls.length === 0) throw new Error("NEAR_RPC_INVALID: at least one RPC URL");
    this.urls = urls;
    this.fetchImpl = fetchImpl;
  }

  private async viewState(prefix: Buffer): Promise<StateValue[]> {
    const result = await rpc<{ values?: StateValue[] }>(this.urls, this.fetchImpl, "query", {
      request_type: "view_state",
      finality: "final",
      account_id: this.rootAccount,
      prefix_base64: prefix.toString("base64"),
    });
    return result.values ?? [];
  }

  private static exact(values: StateValue[], key: Buffer): Buffer | null {
    for (const entry of values) {
      if (entry.key === undefined || entry.value === undefined) continue;
      const entryKey = Buffer.from(entry.key, "base64");
      if (entryKey.equals(key)) return Buffer.from(entry.value, "base64");
    }
    return null;
  }

  async nextTokenId(): Promise<number> {
    const key = Buffer.from(STATE_KEY, "utf8");
    const value = RpcStateReader.exact(await this.viewState(key), key);
    if (value === null || value.length < 8) {
      throw new Error("ISSUER_STATE_INVALID: contract STATE is missing or too short");
    }
    const next = Number(value.readBigUInt64LE(value.length - 8));
    if (!Number.isSafeInteger(next) || next < 1) {
      throw new Error("ISSUER_STATE_INVALID: next_token_id");
    }
    return next;
  }

  async storageCredit(business: string): Promise<bigint> {
    const key = Buffer.concat([Buffer.from(STORAGE_CREDIT_PREFIX, "utf8"), borshString(business)]);
    const value = RpcStateReader.exact(await this.viewState(key), key);
    if (value === null) return 0n;
    if (value.length !== 16) {
      throw new Error("ISSUER_STATE_INVALID: storage_credit is not a U128");
    }
    return value.readBigUInt64LE(0) + (value.readBigUInt64LE(8) << 64n);
  }
}

/** `view_account` success means the claim account exists (blueprint 1.5.4). */
export class RpcAccountChecker implements AccountChecker {
  private readonly urls: string[];
  private readonly fetchImpl: FetchLike;

  constructor(urls: string[], fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    if (urls.length === 0) throw new Error("NEAR_RPC_INVALID: at least one RPC URL");
    this.urls = urls;
    this.fetchImpl = fetchImpl;
  }

  async exists(accountId: string): Promise<boolean> {
    try {
      await rpc(this.urls, this.fetchImpl, "query", {
        request_type: "view_account",
        finality: "final",
        account_id: accountId,
      });
      return true;
    } catch {
      return false;
    }
  }
}
