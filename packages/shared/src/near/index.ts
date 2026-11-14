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
  /** Calls to the first (paid) URL per UTC day. 0 is unlimited. */
  dailyBudget?: number;
  now?: () => number;
  /** Called once when a method fails three times in a row. */
  onAlert?: (event: { method: string; message: string }) => void;
}

export type RpcClass = "send" | "status" | "trigger" | "sweep" | "discover" | "ui";

export interface RpcBudgetHealth {
  used: number;
  budget: number;
  remaining: number;
  pace_per_hour: number;
  by_class: Record<RpcClass, number>;
}

export interface RpcTxHealth {
  tx_sent: number;
  tx_failed: Record<string, number>;
  near_burnt: string;
  methods: Record<
    string,
    { sent: number; failed: number; consecutive_failures: number; near_burnt: string }
  >;
}

/** The priority class of one call; sends and tx status are the only classes that always pay. */
export function rpcClassOf(method: string, feature: string): RpcClass {
  if (/broadcast|send_tx|sendTransaction/i.test(method)) return "send";
  if (method === "tx" || /status/i.test(method) || /status/i.test(feature)) return "status";
  if (/sweep/i.test(feature)) return "sweep";
  if (/discover/i.test(feature)) return "discover";
  if (feature === "watcher" || feature === "watcher:claim" || feature === "watcher:balances")
    return "trigger";
  return "ui";
}

interface TxMethodState {
  sent: number;
  failed: number;
  consecutiveFailures: number;
  nearBurnt: bigint;
  alerted: boolean;
}

function burntOf(value: unknown): bigint {
  if (value === null || typeof value !== "object") return 0n;
  const outcome = value as {
    transaction_outcome?: { outcome?: { tokens_burnt?: unknown } };
    receipts_outcome?: { outcome?: { tokens_burnt?: unknown } }[];
  };
  let total = 0n;
  const add = (raw: unknown): void => {
    if (typeof raw === "string" && /^\d+$/.test(raw)) total += BigInt(raw);
  };
  add(outcome.transaction_outcome?.outcome?.tokens_burnt);
  for (const receipt of outcome.receipts_outcome ?? []) add(receipt.outcome?.tokens_burnt);
  return total;
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
  private readonly budget: number;
  private readonly now: () => number;
  private readonly onAlert: ((event: { method: string; message: string }) => void) | undefined;
  private budgetDay = "";
  private budgetUsed = 0;
  private readonly budgetByClass: Record<RpcClass, number> = {
    send: 0,
    status: 0,
    trigger: 0,
    sweep: 0,
    discover: 0,
    ui: 0,
  };
  private txSent = 0;
  private readonly txMethods = new Map<string, TxMethodState>();
  private readonly endpointState = new Map<string, EndpointState>();
  private readonly readCache = new Map<string, { at: number; value: unknown }>();
  private readonly pendingReads = new Map<string, Promise<unknown>>();
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
    this.budget = Math.max(0, Math.floor(options.dailyBudget ?? 0));
    this.now = options.now ?? Date.now;
    this.onAlert = options.onAlert;
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

  private resetBudget(): void {
    if (this.budget <= 0) return;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day === this.budgetDay) return;
    this.budgetDay = day;
    this.budgetUsed = 0;
    for (const key of Object.keys(this.budgetByClass) as RpcClass[]) this.budgetByClass[key] = 0;
  }

  private chargePaid(cls: RpcClass): void {
    if (this.budget <= 0) return;
    this.resetBudget();
    this.budgetUsed += 1;
    this.budgetByClass[cls] += 1;
  }

  private paidAllowed(cls: RpcClass): boolean {
    if (this.budget <= 0) return true;
    this.resetBudget();
    if (this.budgetUsed < this.budget) return true;
    return cls === "send" || cls === "status";
  }

  /** Budget health for `/health.rpc_budget`. */
  rpcBudget(): RpcBudgetHealth {
    this.resetBudget();
    const now = this.now();
    const dayStart = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    );
    const hours = Math.max((now - dayStart) / 3_600_000, 1 / 60);
    return {
      used: this.budgetUsed,
      budget: this.budget,
      remaining: this.budget <= 0 ? 0 : Math.max(0, this.budget - this.budgetUsed),
      pace_per_hour: Math.round((this.budgetUsed / hours) * 10) / 10,
      by_class: { ...this.budgetByClass },
    };
  }

  /**
   * Endpoint order for a class. Sends/status may use the paid URL; trigger reads may until 100%;
   * sweep/discover/ui use a fallback only, and paid only when every fallback is cooling and the
   * budget is below 80%.
   */
  private urlOrder(cls: RpcClass = "ui"): number[] {
    const now = this.now();
    const all = this.rpcUrls.map((url, index) => ({ url, index }));
    const isReady = (entry: { url: string }): boolean =>
      (this.endpointState.get(entry.url)?.cooldownUntil ?? 0) <= now;
    const ready = all.filter(isReady);
    const cooling = all
      .filter((entry) => !isReady(entry))
      .sort(
        (a, b) =>
          (this.endpointState.get(a.url)?.cooldownUntil ?? 0) -
          (this.endpointState.get(b.url)?.cooldownUntil ?? 0),
      );
    let pool = [...ready, ...cooling];
    if (this.budget > 0) {
      const paid = all[0];
      const freeReady = ready.filter((entry) => entry.index !== 0);
      const freeCooling = cooling.filter((entry) => entry.index !== 0);
      if (cls === "sweep" || cls === "discover" || cls === "ui") {
        if (freeReady.length > 0)
          pool =
            this.budgetUsed < this.budget * 0.8 && paid !== undefined
              ? [...freeReady, ...freeCooling, paid]
              : [...freeReady, ...freeCooling];
        else if (this.budgetUsed < this.budget * 0.8) pool = paid === undefined ? [] : [paid];
        else pool = freeCooling;
      } else if (cls === "trigger" && !this.paidAllowed("trigger")) {
        pool = pool.filter((entry) => entry.index !== 0);
      } else if (paid !== undefined && this.paidAllowed(cls)) {
        const paidReady = ready.some((entry) => entry.index === 0);
        pool = paidReady
          ? [paid, ...pool.filter((entry) => entry.index !== 0)]
          : pool.filter((entry) => entry.index !== 0);
      }
    }
    const paidFirst =
      this.budget > 0 &&
      (cls === "send" || cls === "status" || cls === "trigger") &&
      this.paidAllowed(cls) &&
      pool[0]?.index === 0;
    const freeFirst = cls === "sweep" || cls === "discover" || cls === "ui";
    const start =
      paidFirst || freeFirst ? 0 : pool.findIndex((entry) => entry.index === this.cursor);
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
    cls: RpcClass,
  ): Promise<T> {
    const url = this.rpcUrls[index]!;
    this.noteCall(url);
    this.increment(feature);
    if (index === 0) this.chargePaid(cls);
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
    const cls = rpcClassOf(method, feature);
    if (this.rpcUrls.length === 1) return this.rpcReadOne<T>(method, params, feature, cls);
    const order = this.urlOrder(cls);
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
        this.attempt<T>(index, method, params, feature, this.readTimeoutMs, () => done, cls).then(
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
  private async rpcReadOne<T>(
    method: string,
    params: unknown,
    feature: string,
    cls: RpcClass,
  ): Promise<T> {
    const order = this.urlOrder(cls);
    const index = (order[0] ?? 0) as number;
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
          cls,
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
    const cls = rpcClassOf(method, feature);
    const order = this.urlOrder(cls);
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
            cls,
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
    const pending = this.pendingReads.get(key);
    if (pending !== undefined) return pending as Promise<T>;
    const promise = (async () => {
      const result = await this.rpc<{ result: number[] }>("query", params, feature);
      const bytes = Uint8Array.from(result.result);
      const value = JSON.parse(new TextDecoder().decode(bytes)) as T;
      this.readCache.set(key, { at: Date.now(), value });
      return value;
    })();
    this.pendingReads.set(key, promise);
    let value: T;
    try {
      value = (await promise) as T;
    } finally {
      this.pendingReads.delete(key);
    }
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

  private txState(method: string): TxMethodState {
    let state = this.txMethods.get(method);
    if (state === undefined) {
      state = { sent: 0, failed: 0, consecutiveFailures: 0, nearBurnt: 0n, alerted: false };
      this.txMethods.set(method, state);
    }
    return state;
  }

  private recordTx(method: string, ok: boolean, outcome: unknown): void {
    const state = this.txState(method);
    if (ok) {
      state.sent += 1;
      state.consecutiveFailures = 0;
      state.alerted = false;
      state.nearBurnt += burntOf(outcome);
    } else {
      state.failed += 1;
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures === 3 && !state.alerted) {
        state.alerted = true;
        this.onAlert?.({
          method,
          message: `RPC_TX_FAILED_3: ${method} failed 3 times in a row`,
        });
      }
    }
    this.txSent += ok ? 1 : 0;
  }

  /** Transactions sent/failed by method, and the yoctoNEAR burnt the outcome reports. */
  txHealth(): RpcTxHealth {
    let burnt = 0n;
    const methods: RpcTxHealth["methods"] = {};
    for (const [method, state] of this.txMethods) {
      burnt += state.nearBurnt;
      methods[method] = {
        sent: state.sent,
        failed: state.failed,
        consecutive_failures: state.consecutiveFailures,
        near_burnt: state.nearBurnt.toString(),
      };
    }
    return {
      tx_sent: this.txSent,
      tx_failed: Object.fromEntries(
        [...this.txMethods]
          .filter(([, state]) => state.failed > 0)
          .map(([m, state]) => [m, state.failed]),
      ),
      near_burnt: burnt.toString(),
      methods,
    };
  }

  /** Sign and broadcast a function call, waiting for the RPC result. */
  async sendFunctionCall(request: FunctionCallRequest): Promise<unknown> {
    const signed = await this.signFunctionCall(request);
    const feature = request.feature ?? "near";
    const method = request.methodName;
    try {
      const outcome = await this.rpcSend<unknown>(
        "broadcast_tx_commit",
        [signed.signedTxBase64],
        feature,
      );
      this.recordTx(method, true, outcome);
      return outcome;
    } catch (error) {
      // The send may have landed even when its response timed out. Only then read the outcome,
      // so the normal path still costs one call.
      if (this.signerEnv !== undefined) {
        try {
          const senderId = requireEnv(this.signerEnv.accountIdEnv);
          const outcome = await this.txStatusResult(signed.txHash, senderId);
          const status =
            outcome !== null && typeof outcome === "object"
              ? (outcome as { status?: unknown }).status
              : undefined;
          const failure =
            status !== undefined &&
            typeof status === "object" &&
            status !== null &&
            "Failure" in status;
          if (!failure && outcome !== undefined && outcome !== null) {
            this.recordTx(method, true, outcome);
            return outcome;
          }
        } catch {
          // fall through to the original error
        }
      }
      this.recordTx(method, false, undefined);
      throw error;
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
  const raw = getEnv("NEAR_RPC_DAILY_BUDGET");
  const parsed = raw === undefined || raw === "" ? 0 : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("ENV_INVALID: NEAR_RPC_DAILY_BUDGET");
  return new NearClient({
    ...options,
    rpcUrls: nearRpcUrlsFromEnv(),
    dailyBudget: options.dailyBudget ?? Math.floor(parsed),
    onAlert: options.onAlert ?? ((event) => console.error(event.message)),
  });
}
