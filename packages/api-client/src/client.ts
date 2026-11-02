/**
 * Thin typed client over the S1a OpenAPI contract.
 *
 * Types come from src/generated.ts (generated from services/api/openapi.json).
 * The helpers build paths and forward JSON; they add no business logic.
 */
import type { operations } from "./generated.js";

export * from "./generated.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type OperationParameters<K extends keyof operations> = operations[K] extends {
  parameters: infer P;
}
  ? P
  : never;
type QueryOf<K extends keyof operations> =
  OperationParameters<K> extends { query: infer Q } ? Q : never;
type RequestBodyOf<K extends keyof operations> = operations[K] extends { requestBody: infer B }
  ? B
  : never;
type SuccessStatus<K extends keyof operations> = Extract<
  keyof operations[K]["responses"],
  `2${string}`
>;
export type SuccessBody<K extends keyof operations> = operations[K]["responses"][SuccessStatus<K>];

export interface ApiClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
}

export interface ApiErrorBody {
  error: { code: string; message: string; rule?: string };
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly code: string;
  readonly rule?: string;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const parsed = body as Partial<ApiErrorBody> | undefined;
    const code = parsed?.error?.code ?? `http_${status}`;
    const message = parsed?.error?.message ?? `HTTP ${status}`;
    super(`${code}: ${message}`);
    this.status = status;
    this.code = code;
    this.rule = parsed?.error?.rule;
    this.body = body;
  }
}

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
}

function encodePath(path: string, values: Record<string, string>): string {
  return path.replace(/\{([^}]+)\}/g, (_match, key: string) =>
    encodeURIComponent(values[key] ?? ""),
  );
}

export class OpenrailClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async call<K extends keyof operations>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<SuccessBody<K>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey !== undefined && this.apiKey !== "") {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = options.idempotencyKey;

    const response = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const body: unknown = text === "" ? undefined : JSON.parse(text);
    if (!response.ok) throw new ApiError(response.status, body);
    return body as SuccessBody<K>;
  }

  invoices = {
    create: (
      body: RequestBodyOf<"createInvoice">,
      options: { idempotencyKey?: string } = {},
    ): Promise<SuccessBody<"createInvoice">> =>
      this.call("POST", "/v1/invoices", { body, idempotencyKey: options.idempotencyKey }),
    list: (query?: QueryOf<"listInvoices">): Promise<SuccessBody<"listInvoices">> =>
      this.call("GET", "/v1/invoices", { query: query as Record<string, unknown> | undefined }),
    get: (id: string): Promise<SuccessBody<"getInvoice">> =>
      this.call("GET", `/v1/invoices/${encodeURIComponent(id)}`),
    send: (
      id: string,
      body: RequestBodyOf<"sendInvoice">,
      options: { idempotencyKey?: string } = {},
    ): Promise<SuccessBody<"sendInvoice">> =>
      this.call("POST", `/v1/invoices/${encodeURIComponent(id)}/send`, {
        body,
        idempotencyKey: options.idempotencyKey,
      }),
  };

  payments = {
    get: (id: string): Promise<SuccessBody<"getPayment">> =>
      this.call("GET", `/v1/payments/${encodeURIComponent(id)}`),
  };

  receipts = {
    list: (invoiceId: string): Promise<SuccessBody<"listReceipts">> =>
      this.call("GET", `/v1/invoices/${encodeURIComponent(invoiceId)}/receipts`),
  };

  webhookEndpoints = {
    create: (
      body: RequestBodyOf<"createWebhookEndpoint">,
      options: { idempotencyKey?: string } = {},
    ): Promise<SuccessBody<"createWebhookEndpoint">> =>
      this.call("POST", "/v1/webhook_endpoints", {
        body,
        idempotencyKey: options.idempotencyKey,
      }),
  };

  events = {
    list: (query?: QueryOf<"listEvents">): Promise<SuccessBody<"listEvents">> =>
      this.call("GET", "/v1/events", { query: query as Record<string, unknown> | undefined }),
  };

  routes = {
    list: (): Promise<SuccessBody<"listRoutes">> => this.call("GET", "/v1/routes"),
  };

  pay = {
    createSession: (
      body: RequestBodyOf<"createPaySession">,
      options: { idempotencyKey?: string } = {},
    ): Promise<SuccessBody<"createPaySession">> =>
      this.call("POST", "/v1/pay/sessions", { body, idempotencyKey: options.idempotencyKey }),
    getSession: (id: string): Promise<SuccessBody<"getPaySession">> =>
      this.call("GET", `/v1/pay/sessions/${encodeURIComponent(id)}`),
    getClaim: (tokenId: string): Promise<SuccessBody<"getPublicClaim">> =>
      this.call("GET", `/v1/pay/claims/${encodeURIComponent(tokenId)}`),
  };

  ack = {
    get: (tokenId: string): Promise<SuccessBody<"getAckData">> =>
      this.call("GET", `/v1/ack/${encodeURIComponent(tokenId)}`),
  };

  /** The OpenAPI document itself (not part of the typed operation map). */
  async openapi(): Promise<Record<string, unknown>> {
    return (await this.call<"getOpenApi">("GET", "/v1/openapi.json")) as Record<string, unknown>;
  }
}

export function createClient(options: ApiClientOptions): OpenrailClient {
  return new OpenrailClient(options);
}

export { encodePath };
