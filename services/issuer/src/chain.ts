/**
 * Read-only chain helpers:
 *  - `storage_credit_of` through the shared NearClient view (contract C1b adds the view);
 *  - claim-account existence (blueprint 1.5.4);
 *  - key permission/allowance for the startup self-check and `/health`.
 */
import { getEnv, requireEnv } from "@openrail/shared";
import type {
  AccountChecker,
  KeyInfo,
  KeyInspector,
  NearClientLike,
  SponsorStatus,
  SponsorStatusReader,
  StorageCreditReader,
  TokenCounter,
} from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const KEY_QUERY_TIMEOUT_MS = 15_000;

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
        signal: AbortSignal.timeout(KEY_QUERY_TIMEOUT_MS),
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

/** `storage_credit_of(account_id) -> U128` (contract C1b; method name fixed by the review). */
export class ContractStorageCreditReader implements StorageCreditReader {
  constructor(
    private readonly near: NearClientLike,
    private readonly rootAccount: string,
  ) {}

  async storageCreditOf(business: string): Promise<bigint> {
    const value = await this.near.view<string>({
      contractId: this.rootAccount,
      methodName: "storage_credit_of",
      args: { account_id: business },
      feature: "issuer.storage_credit",
    });
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      throw new Error("ISSUER_STORAGE_CREDIT_INVALID");
    }
    return BigInt(value);
  }
}

export class ContractSponsorStatusReader implements SponsorStatusReader {
  constructor(
    private readonly near: NearClientLike,
    private readonly rootAccount: string,
  ) {}

  async sponsorStatusOf(business: string): Promise<SponsorStatus> {
    const value = await this.near.view<{ pool?: unknown; cap?: unknown; used?: unknown }>({
      contractId: this.rootAccount,
      methodName: "sponsor_status",
      args: { account_id: business },
      feature: "issuer.sponsor_status",
    });
    const pool =
      typeof value.pool === "string" && /^\d+$/.test(value.pool) ? BigInt(value.pool) : null;
    const cap = typeof value.cap === "number" && Number.isSafeInteger(value.cap) ? value.cap : null;
    const used =
      typeof value.used === "number" && Number.isSafeInteger(value.used) ? value.used : null;
    if (pool === null || cap === null || used === null)
      throw new Error("ISSUER_SPONSOR_STATUS_INVALID");
    return { pool, cap, used };
  }
}

/** Reads `next_token_id` from the contract view; no raw contract storage. */
export class ContractTokenCounter implements TokenCounter {
  constructor(
    private readonly near: NearClientLike,
    private readonly rootAccount: string,
  ) {}

  async nextTokenId(): Promise<number> {
    const value = await this.near.view<number>({
      contractId: this.rootAccount,
      methodName: "next_token_id",
      args: {},
      feature: "issuer.next_token_id",
    });
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("ISSUER_NEXT_TOKEN_INVALID");
    return value;
  }
}

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

interface AccessKeyResult {
  permission?: unknown;
}

export class RpcKeyInspector implements KeyInspector {
  private readonly urls: string[];
  private readonly fetchImpl: FetchLike;

  constructor(urls: string[], fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    if (urls.length === 0) throw new Error("NEAR_RPC_INVALID: at least one RPC URL");
    this.urls = urls;
    this.fetchImpl = fetchImpl;
  }

  async keyInfo(accountId: string, publicKey: string): Promise<KeyInfo> {
    const result = await rpc<AccessKeyResult>(this.urls, this.fetchImpl, "query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    });
    if (result.permission === "FullAccess") {
      return { kind: "FullAccess", methods: [], allowance: null };
    }
    const functionCall =
      result.permission !== null && typeof result.permission === "object"
        ? (result.permission as { FunctionCall?: { allowance?: unknown; method_names?: unknown } })
            .FunctionCall
        : undefined;
    if (functionCall === undefined) {
      throw new Error("ISSUER_KEY_PERMISSION_UNKNOWN");
    }
    const methods = Array.isArray(functionCall.method_names)
      ? functionCall.method_names.filter((name): name is string => typeof name === "string")
      : [];
    const allowance = typeof functionCall.allowance === "string" ? functionCall.allowance : null;
    return { kind: "FunctionCall", methods, allowance };
  }
}
