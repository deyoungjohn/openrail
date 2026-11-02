/**
 * 1Click client (blueprint 1.6, 1.5.7, 2.8).
 *
 * - base URL and key come from env;
 * - `Authorization: Bearer <key>` first, `X-API-Key` only after a 401;
 * - status fields live under `swapDetails`;
 * - the key is never logged or put in an error message.
 */
import { redactString, requireEnv } from "../env/index.js";

export type OneClickFetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type AuthMode = "bearer" | "x-api-key";

export interface OneClickQuoteRequest {
  amount?: string;
  swapType?: "FLEX_INPUT" | "EXACT_OUTPUT";
  slippageTolerance?: number;
  originAsset?: string;
  destinationAsset?: string;
  depositType?: string;
  recipient?: string;
  recipientType?: string;
  refundTo?: string;
  refundType?: string;
  deadline?: string;
  dry?: boolean;
  [key: string]: unknown;
}

export interface OneClickQuote {
  amountIn?: string;
  amountOut?: string;
  minAmountIn?: string;
  minAmountOut?: string;
  depositAddress?: string;
  deadline?: string;
  timeEstimate?: number;
  [key: string]: unknown;
}

export interface OneClickQuoteResponse {
  quote: OneClickQuote;
  quoteRequest?: OneClickQuoteRequest;
  signature?: string;
  [key: string]: unknown;
}

export interface SwapDetails {
  status?: string;
  amountOut?: string;
  depositedAmount?: string;
  originChainTxHashes?: string[];
  destinationChainTxHashes?: string[];
  nearTxHashes?: string[];
  [key: string]: unknown;
}

export interface OneClickStatusResponse {
  status?: string;
  updatedAt?: string;
  swapDetails?: SwapDetails;
  [key: string]: unknown;
}

export interface NormalizedStatus {
  status?: string;
  swapDetails: SwapDetails;
  updatedAt?: string;
  raw: OneClickStatusResponse;
}

export interface SubmitDepositRequest {
  txHash: string;
  depositAddress?: string;
  [key: string]: unknown;
}

export interface OneClickClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: OneClickFetchLike;
}

export class OneClickRequestError extends Error {
  override readonly name = "OneClickRequestError";
  readonly status: number;

  constructor(status: number, body: string) {
    super(`ONECLICK_HTTP_${status}: ${body}`);
    this.status = status;
  }
}

function safeBody(body: string, apiKey: string): string {
  const withoutKey = apiKey === "" ? body : body.split(apiKey).join("«redacted»");
  return redactString(withoutKey).slice(0, 500);
}

export class OneClickClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: OneClickFetchLike;
  private mode: AuthMode = "bearer";

  constructor(options: OneClickClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Which header the provider accepted. */
  get authMode(): AuthMode {
    return this.mode;
  }

  private headers(mode: AuthMode): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (mode === "bearer") headers.authorization = `Bearer ${this.apiKey}`;
    else headers["x-api-key"] = this.apiKey;
    return headers;
  }

  private async send(
    url: string,
    init: { method: string; body?: string },
    allowFallback: boolean,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers: this.headers(this.mode),
        body: init.body,
      });
    } catch (error) {
      throw new OneClickRequestError(
        0,
        `network: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.status === 401 && this.mode === "bearer" && allowFallback) {
      this.mode = "x-api-key";
      return this.send(url, init, false);
    }

    const text = await response.text();
    if (!response.ok) throw new OneClickRequestError(response.status, safeBody(text, this.apiKey));
    if (text === "") return {};
    return JSON.parse(text) as unknown;
  }

  /** POST /v0/quote. */
  async quote(request: OneClickQuoteRequest): Promise<OneClickQuoteResponse> {
    const body = await this.send(
      `${this.baseUrl}/v0/quote`,
      { method: "POST", body: JSON.stringify(request) },
      true,
    );
    const response = body as OneClickQuoteResponse;
    if (response.quote === undefined) {
      throw new OneClickRequestError(200, "ONECLICK_INVALID_RESPONSE: missing quote");
    }
    return response;
  }

  /** GET /v0/status; provider progress fields are under swapDetails. */
  async status(depositAddress: string): Promise<NormalizedStatus> {
    const body = (await this.send(
      `${this.baseUrl}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
      { method: "GET" },
      true,
    )) as OneClickStatusResponse;
    const swapDetails = body.swapDetails ?? {};
    return {
      status: swapDetails.status ?? body.status,
      swapDetails,
      updatedAt: body.updatedAt,
      raw: body,
    };
  }

  /** POST /v0/deposit/submit. */
  async submitDeposit(request: SubmitDepositRequest): Promise<unknown> {
    return this.send(
      `${this.baseUrl}/v0/deposit/submit`,
      { method: "POST", body: JSON.stringify(request) },
      true,
    );
  }
}

/** Build a client from ONECLICK_API_URL and ONECLICK_JWT. */
export function createOneClickClientFromEnv(
  options: Pick<OneClickClientOptions, "fetchImpl"> = {},
): OneClickClient {
  return new OneClickClient({
    baseUrl: requireEnv("ONECLICK_API_URL"),
    apiKey: requireEnv("ONECLICK_JWT"),
    ...options,
  });
}
