/**
 * NEAR JSON-RPC client (blueprint 1.6, 2.9).
 *
 * - view calls and batched `mt_batch_balance_of`;
 * - function-call-key signing from env;
 * - retry with backoff;
 * - a quota error fails over to the next RPC instead of being read as rejected;
 * - one counter per feature.
 */
import {
  KeyPairSigner,
  actions,
  base64Encode,
  baseDecode,
  baseEncode,
  createTransaction,
  encodeTransaction,
  type KeyPairString,
} from "near-api-js";
import { getEnv, requireEnv } from "../env/index.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<void>;

export interface SignerEnv {
  accountIdEnv: string;
  privateKeyEnv: string;
}

export interface NearClientOptions {
  rpcUrls: string[];
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
  maxRetries?: number;
  retryBackoffMs?: number;
  signer?: SignerEnv;
  intentsContractId?: string;
  requestTimeoutMs?: number;
}

export interface ViewRequest {
  contractId: string;
  methodName: string;
  args?: Record<string, unknown>;
  feature: string;
}

export interface BatchBalanceRequest {
  accountId: string;
  tokenIds: string[];
  contractId?: string;
  feature?: string;
}

export interface FunctionCallRequest {
  receiverId: string;
  methodName: string;
  args?: Record<string, unknown>;
  gas?: bigint;
  deposit?: bigint;
  feature?: string;
}

export interface SignedFunctionCall {
  signedTxBase64: string;
  txHash: string;
}

export class NearRpcError extends Error {
  override readonly name: string = "NearRpcError";

  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

export class NearQuotaError extends NearRpcError {
  override readonly name = "NearQuotaError";

  constructor(message = "RPC_QUOTA_EXHAUSTED: every RPC is over quota") {
    super(message);
  }
}

type Outcome =
  | { kind: "ok"; value: unknown }
  | { kind: "quota"; error: NearQuotaError }
  | { kind: "retryable"; error: NearRpcError }
  | { kind: "fatal"; error: NearRpcError };

const QUOTA_RE = /quota|rate.?limit|too many requests|daily request limit|request limit/i;

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function quotaError(message: string): NearQuotaError {
  return new NearQuotaError(`RPC_QUOTA_EXCEEDED: ${message}`);
}

export class NearClient {
  private readonly rpcUrls: string[];
  private readonly fetchImpl: FetchLike;
  private readonly sleep: SleepLike;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly intentsContractId: string;
  private readonly signerEnv?: SignerEnv;
  private readonly counts = new Map<string, number>();
  private fallbacks = 0;
  private requestId = 0;
  private signer?: KeyPairSigner;

  constructor(options: NearClientOptions) {
    if (options.rpcUrls.length === 0) throw new Error("NEAR_RPC_INVALID: at least one RPC URL");
    this.rpcUrls = [...options.rpcUrls];
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBackoffMs = options.retryBackoffMs ?? 100;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.intentsContractId = options.intentsContractId ?? "intents.near";
    this.signerEnv = options.signer;
  }

  /** HTTP requests made, per feature. */
  callCounts(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  /** Number of times a call moved to the next RPC. */
  fallbackCount(): number {
    return this.fallbacks;
  }

  private increment(feature: string): void {
    this.counts.set(feature, (this.counts.get(feature) ?? 0) + 1);
  }

  private interpret(status: number, text: string): Outcome {
    if (QUOTA_RE.test(text) || status === 429) {
      return { kind: "quota", error: quotaError(text || `HTTP ${status}`) };
    }
    if (status >= 500)
      return { kind: "retryable", error: new NearRpcError(`RPC_HTTP_${status}`, status) };
    if (status < 200 || status >= 300) {
      return { kind: "fatal", error: new NearRpcError(`RPC_HTTP_${status}: ${text}`, status) };
    }

    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }

    const rpcError = (body as { error?: unknown } | undefined)?.error;
    if (rpcError !== undefined) {
      const message = errorText(rpcError);
      if (QUOTA_RE.test(message)) return { kind: "quota", error: quotaError(message) };
      const code = (rpcError as { code?: number } | undefined)?.code;
      return { kind: "fatal", error: new NearRpcError(`RPC_ERROR: ${message}`, status, code) };
    }

    return { kind: "ok", value: (body as { result?: unknown } | undefined)?.result };
  }

  private async rpc<T>(method: string, params: unknown, feature: string): Promise<T> {
    let lastError: NearRpcError | undefined;
    for (let urlIndex = 0; urlIndex < this.rpcUrls.length; urlIndex += 1) {
      const url = this.rpcUrls[urlIndex];
      if (url === undefined) continue;
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        this.increment(feature);
        let outcome: Outcome;
        try {
          const response = await this.fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: (this.requestId += 1),
              method,
              params,
            }),
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          });
          outcome = this.interpret(response.status, await response.text());
        } catch (error) {
          outcome = {
            kind: "retryable",
            error: new NearRpcError(
              `RPC_NETWORK: ${error instanceof Error ? error.message : String(error)}`,
            ),
          };
        }

        if (outcome.kind === "ok") return outcome.value as T;
        lastError = outcome.error;

        if (outcome.kind === "quota") {
          if (urlIndex < this.rpcUrls.length - 1) {
            this.fallbacks += 1;
            break;
          }
          throw outcome.error;
        }
        if (outcome.kind === "retryable") {
          if (attempt < this.maxRetries) {
            await this.sleep(this.retryBackoffMs * 2 ** attempt);
            continue;
          }
          if (urlIndex < this.rpcUrls.length - 1) {
            this.fallbacks += 1;
            break;
          }
          throw outcome.error;
        }
        throw outcome.error;
      }
    }
    throw lastError ?? new NearRpcError("RPC_UNAVAILABLE");
  }

  private async query<T>(params: Record<string, unknown>, feature: string): Promise<T> {
    const result = await this.rpc<{ result: number[] }>("query", params, feature);
    const bytes = Uint8Array.from(result.result);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  /** A read-only contract call (`query` + `call_function`, finality final). */
  async view<T>(request: ViewRequest): Promise<T> {
    return this.query<T>(
      {
        request_type: "call_function",
        finality: "final",
        account_id: request.contractId,
        method_name: request.methodName,
        args_base64: Buffer.from(JSON.stringify(request.args ?? {}), "utf8").toString("base64"),
      },
      request.feature,
    );
  }

  /** Batched `mt_batch_balance_of` against intents.near (100 accounts per call in the watcher). */
  async batchBalanceOf(request: BatchBalanceRequest): Promise<string[]> {
    const result = await this.query<unknown>(
      {
        request_type: "call_function",
        finality: "final",
        account_id: request.contractId ?? this.intentsContractId,
        method_name: "mt_batch_balance_of",
        args_base64: Buffer.from(
          JSON.stringify({ account_id: request.accountId, token_ids: request.tokenIds }),
          "utf8",
        ).toString("base64"),
      },
      request.feature ?? "watcher",
    );
    if (!Array.isArray(result) || !result.every((entry) => typeof entry === "string")) {
      throw new NearRpcError("RPC_INVALID_RESULT: mt_batch_balance_of did not return string[]");
    }
    return result;
  }

  private getSigner(): KeyPairSigner {
    if (this.signer !== undefined) return this.signer;
    if (this.signerEnv === undefined) {
      throw new Error("NEAR_SIGNER_MISSING: no signer env names configured");
    }
    const secret = requireEnv(this.signerEnv.privateKeyEnv);
    this.signer = KeyPairSigner.fromSecretKey(secret as KeyPairString);
    return this.signer;
  }

  /** Sign a function-call transaction with the function-call key from env (no send). */
  async signFunctionCall(request: FunctionCallRequest): Promise<SignedFunctionCall> {
    if (this.signerEnv === undefined) {
      throw new Error("NEAR_SIGNER_MISSING: no signer env names configured");
    }
    const accountId = requireEnv(this.signerEnv.accountIdEnv);
    const feature = request.feature ?? "near";
    const signer = this.getSigner();
    const publicKey = await signer.getPublicKey();

    const [accessKey, block] = await Promise.all([
      this.rpc<{ nonce: number | string; block_hash: string }>(
        "query",
        {
          request_type: "view_access_key",
          finality: "final",
          account_id: accountId,
          public_key: publicKey.toString(),
        },
        feature,
      ),
      this.rpc<{ header: { hash: string } }>("block", { finality: "final" }, feature),
    ]);

    const transaction = createTransaction(
      accountId,
      publicKey,
      request.receiverId,
      BigInt(accessKey.nonce) + 1n,
      [
        actions.functionCall(
          request.methodName,
          request.args ?? {},
          request.gas ?? 100_000_000_000_000n,
          request.deposit ?? 0n,
        ),
      ],
      baseDecode(block.header.hash),
    );
    const signed = await signer.signTransaction(transaction);
    return {
      signedTxBase64: base64Encode(encodeTransaction(signed.signedTransaction)),
      txHash: baseEncode(signed.txHash),
    };
  }

  /** Sign and broadcast a function call, waiting for the RPC result. */
  async sendFunctionCall(request: FunctionCallRequest): Promise<unknown> {
    const signed = await this.signFunctionCall(request);
    return this.rpc<unknown>(
      "broadcast_tx_commit",
      [signed.signedTxBase64],
      request.feature ?? "near",
    );
  }
}

/** Build a client from NEAR_RPC_URL and an optional NEAR_RPC_URL_FALLBACK. */
export function nearClientFromEnv(options: Omit<NearClientOptions, "rpcUrls"> = {}): NearClient {
  const primary = requireEnv("NEAR_RPC_URL");
  const fallback = getEnv("NEAR_RPC_URL_FALLBACK");
  const urls = [...primary.split(","), ...(fallback === undefined ? [] : [fallback])]
    .map((url) => url.trim())
    .filter((url) => url !== "");
  return new NearClient({ ...options, rpcUrls: urls });
}
