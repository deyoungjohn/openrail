/**
 * Thin typed client over the S1a OpenAPI contract.
 *
 * Types come from src/generated.ts (generated from services/api/openapi.json).
 * The helpers build paths and forward JSON; they add no business logic.
 */
import type { operations } from "./generated";

export * from "./generated";

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
  credentials?: "omit" | "same-origin" | "include";
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
  private readonly credentials: "omit" | "same-origin" | "include";

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.credentials = options.credentials ?? "include";
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
    if (options.body !== undefined || method !== "GET") {
      headers["content-type"] = "application/json";
    }
    if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = options.idempotencyKey;

    const response = await this.fetchImpl(url.toString(), {
      method,
      headers,
      credentials: this.credentials,
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
    pdf: (id: string): Promise<SuccessBody<"getInvoicePdf">> =>
      this.call("GET", `/v1/invoices/${encodeURIComponent(id)}/pdf`),
    openQuotes: (id: string): Promise<SuccessBody<"listOpenQuotes">> =>
      this.call("GET", `/v1/invoices/${encodeURIComponent(id)}/open_quotes`),
  };

  payments = {
    list: (): Promise<SuccessBody<"listPayments">> => this.call("GET", "/v1/payments"),
    get: (id: string): Promise<SuccessBody<"getPayment">> =>
      this.call("GET", `/v1/payments/${encodeURIComponent(id)}`),
  };

  receipts = {
    list: (invoiceId: string): Promise<SuccessBody<"listReceipts">> =>
      this.call("GET", `/v1/invoices/${encodeURIComponent(invoiceId)}/receipts`),
    getPublic: (bookingTxHash: string): Promise<SuccessBody<"getPublicReceipt">> =>
      this.call("GET", `/v1/receipts/${encodeURIComponent(bookingTxHash)}`),
    pdf: (bookingTxHash: string): Promise<SuccessBody<"getReceiptPdf">> =>
      this.call("GET", `/v1/receipts/${encodeURIComponent(bookingTxHash)}.pdf`),
  };

  webhookEndpoints = {
    list: (): Promise<SuccessBody<"listWebhookEndpoints">> =>
      this.call("GET", "/v1/webhook_endpoints"),
    create: (
      body: RequestBodyOf<"createWebhookEndpoint">,
      options: { idempotencyKey?: string } = {},
    ): Promise<SuccessBody<"createWebhookEndpoint">> =>
      this.call("POST", "/v1/webhook_endpoints", {
        body,
        idempotencyKey: options.idempotencyKey,
      }),
    delete: (id: string): Promise<SuccessBody<"deleteWebhookEndpoint">> =>
      this.call("DELETE", `/v1/webhook_endpoints/${encodeURIComponent(id)}`),
    test: (
      id: string,
      options: { idempotencyKey?: string } = {},
    ): Promise<SuccessBody<"testWebhookEndpoint">> =>
      this.call("POST", `/v1/webhook_endpoints/${encodeURIComponent(id)}/test`, {
        idempotencyKey: options.idempotencyKey,
      }),
    deliveries: (
      id: string,
      query?: QueryOf<"listWebhookDeliveries">,
    ): Promise<SuccessBody<"listWebhookDeliveries">> =>
      this.call("GET", `/v1/webhook_endpoints/${encodeURIComponent(id)}/deliveries`, {
        query: query as Record<string, unknown> | undefined,
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
    /** The wallet sent the deposit: the provider is told its hash, so the status ticks sooner. */
    nudgeDeposit: (id: string, txHash: string): Promise<SuccessBody<"nudgePayDeposit">> =>
      this.call("POST", `/v1/pay/sessions/${encodeURIComponent(id)}/deposit`, {
        body: { tx_hash: txHash },
      }),
    getSession: (id: string): Promise<SuccessBody<"getPaySession">> =>
      this.call("GET", `/v1/pay/sessions/${encodeURIComponent(id)}`),
    listSessions: (tokenId: string): Promise<SuccessBody<"listPaySessions">> =>
      this.call("GET", `/v1/pay/claims/${encodeURIComponent(tokenId)}/sessions`),
    getClaim: (tokenId: string): Promise<SuccessBody<"getPublicClaim">> =>
      this.call("GET", `/v1/pay/claims/${encodeURIComponent(tokenId)}`),
  };

  ack = {
    get: (tokenId: string): Promise<SuccessBody<"getAckData">> =>
      this.call("GET", `/v1/ack/${encodeURIComponent(tokenId)}`),
    evm: (
      tokenId: string,
      body: RequestBodyOf<"acknowledgeEvm">,
      options: { idempotencyKey?: string } = {},
    ): Promise<SuccessBody<"acknowledgeEvm">> =>
      this.call("POST", `/v1/ack/${encodeURIComponent(tokenId)}/evm`, {
        body,
        idempotencyKey: options.idempotencyKey,
      }),
  };

  auth = {
    challenge: (
      body: RequestBodyOf<"createAuthChallenge">,
      options: { idempotencyKey?: string } = {},
    ): Promise<SuccessBody<"createAuthChallenge">> =>
      this.call("POST", "/v1/auth/challenge", {
        body,
        idempotencyKey: options.idempotencyKey,
      }),
    verify: (
      body: RequestBodyOf<"verifyAuthChallenge">,
      options: { idempotencyKey?: string } = {},
    ): Promise<SuccessBody<"verifyAuthChallenge">> =>
      this.call("POST", "/v1/auth/verify", {
        body,
        idempotencyKey: options.idempotencyKey,
      }),
    session: (): Promise<SuccessBody<"getAuthSession">> => this.call("GET", "/v1/auth/session"),
    logout: (options: { idempotencyKey?: string } = {}): Promise<SuccessBody<"logout">> =>
      this.call("POST", "/v1/auth/logout", { idempotencyKey: options.idempotencyKey }),
  };

  apiKeys = {
    list: (): Promise<SuccessBody<"listApiKeys">> => this.call("GET", "/v1/api_keys"),
    create: (
      body: RequestBodyOf<"createApiKey">,
      options: { idempotencyKey?: string } = {},
    ): Promise<SuccessBody<"createApiKey">> =>
      this.call("POST", "/v1/api_keys", { body, idempotencyKey: options.idempotencyKey }),
    rotate: (
      id: string,
      options: { idempotencyKey?: string } = {},
    ): Promise<SuccessBody<"rotateApiKey">> =>
      this.call("POST", `/v1/api_keys/${encodeURIComponent(id)}/rotate`, {
        idempotencyKey: options.idempotencyKey,
      }),
    delete: (id: string): Promise<SuccessBody<"deleteApiKey">> =>
      this.call("DELETE", `/v1/api_keys/${encodeURIComponent(id)}`),
  };

  business = {
    get: (): Promise<SuccessBody<"getBusiness">> => this.call("GET", "/v1/business"),
    update: (body: RequestBodyOf<"updateBusiness">): Promise<SuccessBody<"updateBusiness">> =>
      this.call("PUT", "/v1/business", { body }),
    storageCredit: (): Promise<SuccessBody<"getStorageCredit">> =>
      this.call("GET", "/v1/business/storage_credit"),
  };

  statements = {
    get: (query?: QueryOf<"getStatement">): Promise<SuccessBody<"getStatement">> =>
      this.call("GET", "/v1/statements", {
        query: query as Record<string, unknown> | undefined,
      }),
  };

  cashout = {
    quote: (
      body: RequestBodyOf<"createCashoutQuote">,
      options: { idempotencyKey?: string } = {},
    ): Promise<SuccessBody<"createCashoutQuote">> =>
      this.call("POST", "/v1/cashout/quote", {
        body,
        idempotencyKey: options.idempotencyKey,
      }),
    list: (): Promise<SuccessBody<"listCashouts">> => this.call("GET", "/v1/cashouts"),
    get: (id: string): Promise<SuccessBody<"getCashout">> =>
      this.call("GET", `/v1/cashouts/${encodeURIComponent(id)}`),
    /** Attaches the transaction the merchant signed, so the money can be followed. */
    sent: (id: string, txHash: string): Promise<SuccessBody<"markCashoutSent">> =>
      this.call("POST", `/v1/cashouts/${encodeURIComponent(id)}/sent`, {
        body: { tx_hash: txHash },
      }),
  };

  /** What the business holds on intents.near, read by the server (the browser never talks to an RPC). */
  balance = {
    intents: (): Promise<SuccessBody<"getIntentsBalance">> =>
      this.call("GET", "/v1/balance/intents"),
  };

  /** The private balance: withdraw to a wallet. The money-moving steps need a signed-in session, not an API key. */
  confidential = {
    keyStatus: (publicKey: string): Promise<SuccessBody<"getConfidentialKeyStatus">> =>
      this.call("GET", "/v1/balance/confidential/key", { query: { public_key: publicKey } }),
    withdrawQuote: (
      body: RequestBodyOf<"confidentialWithdrawQuote">,
    ): Promise<SuccessBody<"confidentialWithdrawQuote">> =>
      this.call("POST", "/v1/balance/confidential/withdraw/quote", { body }),
    withdrawIntent: (depositAddress: string): Promise<SuccessBody<"confidentialWithdrawIntent">> =>
      this.call("POST", "/v1/balance/confidential/withdraw/intent", {
        body: { deposit_address: depositAddress },
      }),
    withdrawSubmit: (
      signedData: Record<string, unknown>,
    ): Promise<SuccessBody<"confidentialWithdrawSubmit">> =>
      this.call("POST", "/v1/balance/confidential/withdraw/submit", {
        body: { signed_data: signedData },
      }),
    withdrawStatus: (depositAddress: string): Promise<SuccessBody<"confidentialWithdrawStatus">> =>
      this.call("GET", "/v1/balance/confidential/withdraw/status", {
        query: { deposit_address: depositAddress },
      }),
    /** Withdrawals started on this site, newest first, with explorer links. */
    withdrawals: (): Promise<SuccessBody<"listConfidentialWithdrawals">> =>
      this.call("GET", "/v1/balance/confidential/withdrawals"),
    /** Adds an earlier withdrawal (one made before they were recorded, or from the CLI) by its deposit address. */
    importWithdrawal: (
      depositAddress: string,
    ): Promise<SuccessBody<"importConfidentialWithdrawal">> =>
      this.call("POST", "/v1/balance/confidential/withdrawals", {
        body: { deposit_address: depositAddress },
      }),
    /** The empty intent the wallet signs to open a session (versioned nonce, 4-minute window). */
    authPayload: (): Promise<SuccessBody<"getConfidentialAuthPayload">> =>
      this.call("GET", "/v1/balance/confidential/auth-payload"),
    /** Exchanges the signed payload for a session kept by the API (the provider's token never reaches the browser). */
    session: (
      signedData: Record<string, unknown>,
    ): Promise<SuccessBody<"createConfidentialSession">> =>
      this.call("POST", "/v1/balance/confidential/session", { body: { signed_data: signedData } }),
    /** The real private balance; 409 `confidential_session_required` until a session exists. */
    balance: (): Promise<SuccessBody<"getConfidentialBalance">> =>
      this.call("GET", "/v1/balance/confidential"),
  };

  health = (): Promise<SuccessBody<"getHealth">> => this.call("GET", "/v1/health");

  analytics = (): Promise<SuccessBody<"getAnalytics">> => this.call("GET", "/v1/analytics");

  /** The OpenAPI document itself (not part of the typed operation map). */
  async openapi(): Promise<Record<string, unknown>> {
    return (await this.call<"getOpenApi">("GET", "/v1/openapi.json")) as Record<string, unknown>;
  }
}

export function createClient(options: ApiClientOptions): OpenrailClient {
  return new OpenrailClient(options);
}

export { encodePath };
