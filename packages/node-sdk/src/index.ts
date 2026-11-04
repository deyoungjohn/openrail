/** `@openrail/node`: typed API helpers and webhook verification. */
import {
  createClient,
  type ApiClientOptions,
  type OpenrailClient,
  type SuccessBody,
} from "@openrail/api-client";
import { createHmac, timingSafeEqual } from "node:crypto";

export * from "@openrail/api-client";

export type OpenrailOptions = ApiClientOptions;

export interface WebhookVerifier {
  (
    payload: string | Record<string, unknown>,
    header: string | undefined,
    secret: string,
    toleranceSeconds?: number,
  ): boolean;
}

function bodyOf(payload: string | Record<string, unknown>): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

/** Verify `Openrail-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>`. */
export const verifyWebhook: WebhookVerifier = (payload, header, secret, toleranceSeconds = 300) => {
  if (header === undefined || header === "") return false;
  const parts = new Map(
    header
      .split(",")
      .map((part) => part.trim().split("=", 2) as [string, string])
      .filter(([key, value]) => key !== "" && value !== undefined),
  );
  const timestamp = Number(parts.get("t"));
  const signature = parts.get("v1");
  if (
    !Number.isSafeInteger(timestamp) ||
    signature === undefined ||
    !/^[0-9a-f]{64}$/i.test(signature)
  ) {
    return false;
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${bodyOf(payload)}`)
    .digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export class OpenrailNode {
  readonly client: OpenrailClient;

  constructor(options: OpenrailOptions) {
    this.client = createClient(options);
  }

  invoices = {
    create: (
      body: Parameters<OpenrailClient["invoices"]["create"]>[0],
      options: { idempotencyKey?: string } = {},
    ): Promise<SuccessBody<"createInvoice">> => this.client.invoices.create(body, options),
    get: (id: string): Promise<SuccessBody<"getInvoice">> => this.client.invoices.get(id),
    list: (
      query?: Parameters<OpenrailClient["invoices"]["list"]>[0],
    ): Promise<SuccessBody<"listInvoices">> => this.client.invoices.list(query),
  };

  webhooks = {
    verify: (
      payload: string | Record<string, unknown>,
      header: string | undefined,
      secret: string,
      toleranceSeconds?: number,
    ): boolean => verifyWebhook(payload, header, secret, toleranceSeconds),
  };
}

export function createOpenrail(options: OpenrailOptions): OpenrailNode {
  return new OpenrailNode(options);
}
