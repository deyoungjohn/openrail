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
  /** The most requests in flight at once from this client (a provider's per-second limit is easy to burst past). */
  maxConcurrent?: number;
  /** A read is sent to the next RPC after this long without an answer. */
  hedgeDelayMs?: number;
  /** Read timeout; a stuck host must not hold a service for the whole request budget. */
  readTimeoutMs?: number;
  /** How long a 429/network failure keeps an RPC out of rotation. */
  cooldownMs?: number;
  /** The same read within this window is shared. */
  cacheMs?: number;
}

export interface RpcEndpointHealth {
  host: string;
  state: "ok" | "cooling";
  last_error: string | null;
  calls_last_hour: number;
}

interface EndpointState {
  lastSuccess: number;
  lastFailure: number;
  cooldownUntil: number;
  lastError: string | null;
  calls: number[];
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
  private readonly maxConcurrent: number;
  private readonly hedgeDelayMs: number;
  private readonly readTimeoutMs: number;
  private readonly cooldownMs: number;
  private readonly cacheMs: number;
  private readonly endpointState = new Map<string, EndpointState>();
  private readonly readCache = new Map<string, { at: number; value: unknown }>();
  /** Where the next call starts: the RPC that answered last. */
  private cursor = 0;
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];
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
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 6);
    this.hedgeDelayMs = Math.max(0, options.hedgeDelayMs ?? 1_500);
    this.readTimeoutMs = Math.max(100, options.readTimeoutMs ?? 4_000);
    this.cooldownMs = Math.max(1_000, options.cooldownMs ?? 60_000);
    this.cacheMs = Math.max(0, options.cacheMs ?? 2_000);
    for (const url of this.rpcUrls) {
      this.endpointState.set(url, {
        lastSuccess: 0,
        lastFailure: 0,
        cooldownUntil: 0,
        lastError: null,
        calls: [],
      });
    }
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

  private async acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.inFlight -= 1;
  }

  /**
   * Healthy RPCs first, starting from the one that answered last. Cooling RPCs are skipped; when
   * every RPC is cooling, the one whose cooldown ends first is tried.
   */
  private urlOrder(): number[] {
    const now = Date.now();
    const all = this.rpcUrls.map((url, index) => ({ url, index }));
    const ready = all.filter(
      (entry) => (this.endpointState.get(entry.url)?.cooldownUntil ?? 0) <= now,
    );
    const cooling = all
      .filter((entry) => !ready.includes(entry))
      .sort(
        (a, b) =>
          (this.endpointState.get(a.url)?.cooldownUntil ?? 0) -
          (this.endpointState.get(b.url)?.cooldownUntil ?? 0),
      );
    // Cooling endpoints are only a last resort, after every ready endpoint has failed.
    const pool = [...ready, ...cooling];
    const start = pool.findIndex((entry) => entry.index === this.cursor);
    return pool.map((_, k) => pool[((start < 0 ? 0 : start) + k) % pool.length]!.index);
  }

  private state(url: string): EndpointState {
    let state = this.endpointState.get(url);
    if (state === undefined) {
      state = { lastSuccess: 0, lastFailure: 0, cooldownUntil: 0, lastError: null, calls: [] };
      this.endpointState.set(url, state);
    }
    return state;
  }

  private noteCall(url: string): void {
    const state = this.state(url);
    state.calls.push(Date.now());
  }

  private noteOk(url: string, index: number): void {
    const state = this.state(url);
    state.lastSuccess = Date.now();
    state.cooldownUntil = 0;
    state.lastError = null;
    this.cursor = index;
  }

  private noteFailure(url: string, message: string, cooldownMs: number): void {
    const state = this.state(url);
    state.lastFailure = Date.now();
    state.lastError = message;
    if (cooldownMs > 0) state.cooldownUntil = Date.now() + cooldownMs;
  }

  /** Endpoint hosts (no paths or keys), state, last error word and calls in the last hour. */
  rpcHealth(now = Date.now()): RpcEndpointHealth[] {
    const hourAgo = now - 3_600_000;
    return this.rpcUrls.map((url) => {
      const state = this.state(url);
      state.calls = state.calls.filter((at) => at >= hourAgo);
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        // keep the raw value when it is not a URL
      }
      return {
        host,
        state: state.cooldownUntil > now ? "cooling" : "ok",
        last_error: state.lastError,
        calls_last_hour: state.calls.length,
      };
    });
  }

  private async attempt<T>(
    index: number,
    method: string,
    params: unknown,
    feature: string,
    timeoutMs: number,
    settled: () => boolean,
  ): Promise<T> {
    const url = this.rpcUrls[index]!;
    this.noteCall(url);
    this.increment(feature);
    await this.acquire();
    try {
      if (settled()) throw new NearRpcError("RPC_HEDGE_ABANDONED");
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: (this.requestId += 1),
          method,
          params,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      const outcome = this.interpret(response.status, text);
      if (outcome.kind === "ok") {
        this.noteOk(url, index);
        return outcome.value as T;
      }
      if (outcome.kind === "quota") {
        const retryAfter = Number(response.headers.get("retry-after"));
        const cool =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.cooldownMs;
        this.noteFailure(url, outcome.error.message.split(":")[0] ?? "RPC_QUOTA", cool);
      } else if (outcome.kind === "retryable") {
        this.noteFailure(url, outcome.error.message, this.cooldownMs);
      } else {
        this.noteFailure(url, outcome.error.message, 0);
      }
      throw outcome.error;
    } catch (error) {
      if (error instanceof NearRpcError) throw error;
      const message = `RPC_NETWORK: ${error instanceof Error ? error.message : String(error)}`;
      this.noteFailure(url, message, this.cooldownMs);
      throw new NearRpcError(message);
    } finally {
      this.release();
    }
  }

  /**
   * A read: start at the best RPC; after `hedgeDelayMs` without an answer, start the next; after
   * a definite failure, start the next at once; take the first good answer.
   */
  private async rpcRead<T>(method: string, params: unknown, feature: string): Promise<T> {
    if (this.rpcUrls.length === 1) return this.rpcReadOne<T>(method, params, feature);
    const order = this.urlOrder();
    return new Promise<T>((resolve, reject) => {
      let next = 0;
      let active = 0;
      let done = false;
      let lastError: NearRpcError | undefined;
      const timers: ReturnType<typeof setTimeout>[] = [];

      const finishError = (error: NearRpcError): void => {
        if (done) return;
        done = true;
        for (const timer of timers) clearTimeout(timer);
        reject(error);
      };
      const launch = (): void => {
        if (done || next >= order.length) return;
        const index = order[next] as number;
        if (next > 0) this.fallbacks += 1;
        next += 1;
        active += 1;
        const hedge = setTimeout(() => {
          if (!done) launch();
        }, this.hedgeDelayMs);
        timers.push(hedge);
        this.attempt<T>(index, method, params, feature, this.readTimeoutMs, () => done).then(
          (value) => {
            clearTimeout(hedge);
            if (done) return;
            done = true;
            for (const timer of timers) clearTimeout(timer);
            resolve(value);
          },
          (error: unknown) => {
            clearTimeout(hedge);
            active -= 1;
            const rpcError =
              error instanceof NearRpcError ? error : new NearRpcError(String(error));
            if (!/RPC_HEDGE_ABANDONED/.test(rpcError.message)) lastError = rpcError;
            if (
              rpcError.status !== undefined &&
              rpcError.status >= 400 &&
              rpcError.status < 500 &&
              !(rpcError instanceof NearQuotaError)
            ) {
              finishError(rpcError);
              return;
            }
            if (/^RPC_ERROR/.test(rpcError.message)) {
              finishError(rpcError);
              return;
            }
            if (!done) launch();
            if (!done && next >= order.length && active === 0) {
              finishError(lastError ?? new NearRpcError("RPC_UNAVAILABLE"));
            }
          },
        );
      };
      launch();
    });
  }

  /** A single endpoint keeps the old retry/backoff for a transient failure. */
  private async rpcReadOne<T>(method: string, params: unknown, feature: string): Promise<T> {
    const index = this.urlOrder()[0] as number;
    let lastError: NearRpcError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.attempt<T>(
          index,
          method,
          params,
          feature,
          this.readTimeoutMs,
          () => false,
        );
      } catch (error) {
        const rpcError = error instanceof NearRpcError ? error : new NearRpcError(String(error));
        lastError = rpcError;
        if (rpcError.status !== undefined && rpcError.status >= 400 && rpcError.status < 500)
          throw rpcError;
        if (attempt < this.maxRetries) await this.sleep(this.retryBackoffMs * 2 ** attempt);
      }
    }
    throw lastError ?? new NearRpcError("RPC_UNAVAILABLE");
  }

  /**
   * A broadcast: one RPC; move on only after a definite rejection (429 or HTTP 5xx). A network
   * error or timeout is not repeated here; `sendFunctionCall` reads the transaction status first.
   */
  private async rpcSend<T>(method: string, params: unknown, feature: string): Promise<T> {
    let lastError: NearRpcError | undefined;
    const order = this.urlOrder();
    const attempts = this.rpcUrls.length === 1 ? this.maxRetries + 1 : 1;
    for (let k = 0; k < order.length; k += 1) {
      const index = order[k] as number;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          return await this.attempt<T>(
            index,
            method,
            params,
            feature,
            this.requestTimeoutMs,
            () => false,
          );
        } catch (error) {
          const rpcError = error instanceof NearRpcError ? error : new NearRpcError(String(error));
          lastError = rpcError;
          const definite =
            rpcError instanceof NearQuotaError ||
            (rpcError.status !== undefined &&
              rpcError.status >= 500 &&
              rpcError.status !== 504 &&
              rpcError.status !== 408);
          if (!definite) throw rpcError;
          if (attempt < attempts - 1) {
            await this.sleep(this.retryBackoffMs * 2 ** attempt);
            continue;
          }
        }
      }
      if (k < order.length - 1) this.fallbacks += 1;
    }
    throw lastError ?? new NearRpcError("RPC_UNAVAILABLE");
  }

  private async rpc<T>(method: string, params: unknown, feature: string): Promise<T> {
    return this.rpcRead<T>(method, params, feature);
  }

  private async query<T>(params: Record<string, unknown>, feature: string): Promise<T> {
    const key = JSON.stringify(params);
    const now = Date.now();
    const cached = this.readCache.get(key);
    if (cached !== undefined && now - cached.at < this.cacheMs) return cached.value as T;
    const result = await this.rpc<{ result: number[] }>("query", params, feature);
    const bytes = Uint8Array.from(result.result);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as T;
    this.readCache.set(key, { at: now, value });
    if (this.readCache.size > 100) {
      for (const [entry, hit] of this.readCache) {
        if (now - hit.at >= this.cacheMs) this.readCache.delete(entry);
      }
    }
    return value;
  }

  /** The NEAR balance of an account in yoctoNEAR. Throws when no RPC can say: a failed read is not a zero balance. */
  async accountBalanceYocto(accountId: string): Promise<bigint> {
    const result = await this.rpc<{ amount?: unknown }>(
      "query",
      { request_type: "view_account", finality: "final", account_id: accountId },
      "account_balance",
    );
    if (typeof result?.amount !== "string" || !/^\d+$/.test(result.amount)) {
      throw new NearRpcError("RPC_RESULT_MISSING");
    }
    return BigInt(result.amount);
  }

  /**
   * What became of a transaction: `success`, `failed`, or `pending` (not executed yet, or not known to the node yet).
   * An RPC that cannot answer throws, so a caller can tell "unknown" from "pending".
   */
  async txStatus(txHash: string, senderId: string): Promise<"success" | "failed" | "pending"> {
    try {
      const result = await this.rpc<{ status?: Record<string, unknown> | string }>(
        "tx",
        [txHash, senderId],
        "tx_status",
      );
      const status = result.status;
      if (typeof status === "object" && status !== null) {
        if ("Failure" in status) return "failed";
        if ("SuccessValue" in status || "SuccessReceiptId" in status) return "success";
      }
      return "pending";
    } catch (error) {
      if (
        error instanceof NearRpcError &&
        /UNKNOWN_TRANSACTION|doesn't exist|not found/i.test(error.message)
      )
        return "pending";
      throw error;
    }
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

  /** `EXPERIMENTAL_tx_status`: the full outcome, used when a broadcast timed out. */
  async txStatusResult(txHash: string, senderId: string): Promise<unknown> {
    return this.rpc<unknown>(
      "EXPERIMENTAL_tx_status",
      { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" },
      "tx_status_outcome",
    );
  }

  /** Sign and broadcast a function call, waiting for the RPC result. */
  async sendFunctionCall(request: FunctionCallRequest): Promise<unknown> {
    const signed = await this.signFunctionCall(request);
    const feature = request.feature ?? "near";
    try {
      return await this.rpcSend<unknown>("broadcast_tx_commit", [signed.signedTxBase64], feature);
    } catch (error) {
      // The send may have landed even when its response timed out. Only then read the outcome,
      // so the normal path still costs one call.
      if (this.signerEnv === undefined) throw error;
      const senderId = requireEnv(this.signerEnv.accountIdEnv);
      const outcome = await this.txStatusResult(signed.txHash, senderId);
      const status =
        outcome !== null && typeof outcome === "object"
          ? (outcome as { status?: unknown }).status
          : undefined;
      if (
        status !== undefined &&
        typeof status === "object" &&
        status !== null &&
        "Failure" in status
      )
        throw error;
      if (outcome === undefined || outcome === null) throw error;
      return outcome;
    }
  }
}

/**
 * Every RPC the services may use, in order: NEAR_RPC_URL, then NEAR_RPC_URL_FALLBACK, then
 * NEAR_RPC_URL_FALLBACK_2 … _9. Each value may itself be a comma-separated list. Duplicates are dropped.
 */
export function nearRpcUrlsFromEnv(): string[] {
  const names = [
    "NEAR_RPC_URL",
    "NEAR_RPC_URL_FALLBACK",
    // Both spellings are read: FALLBACK_2 and FALLBACK2 (and FALLBACK1 for the first).
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [
      `NEAR_RPC_URL_FALLBACK_${n}`,
      `NEAR_RPC_URL_FALLBACK${n}`,
    ]),
  ];
  const urls: string[] = [];
  for (const name of names) {
    const value = name === "NEAR_RPC_URL" ? requireEnv(name) : getEnv(name);
    for (const part of (value ?? "").split(",")) {
      const url = part.trim();
      if (url !== "" && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

const cycles = new Map<string, number>();

/** The RPCs in the order to try them: from the one that answered last, round through the rest. */
export function rpcOrder(urls: readonly string[]): string[] {
  const start = (cycles.get(urls.join(",")) ?? 0) % Math.max(1, urls.length);
  return urls.map((_, k) => urls[(start + k) % urls.length] as string);
}

/** Remember which RPC answered, so the next call starts there. */
export function rpcWorked(urls: readonly string[], url: string): void {
  const index = urls.indexOf(url);
  if (index >= 0) cycles.set(urls.join(","), index);
}

/** Build a client from NEAR_RPC_URL and its fallbacks (see nearRpcUrlsFromEnv). */
export function nearClientFromEnv(options: Omit<NearClientOptions, "rpcUrls"> = {}): NearClient {
  return new NearClient({ ...options, rpcUrls: nearRpcUrlsFromEnv() });
}
