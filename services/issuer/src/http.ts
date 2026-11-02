/**
 * Local-only HTTP surface for the API (`IssuerPort`, PR #27).
 *
 * Auth is a constant-time comparison of `ISSUER_SERVICE_KEY`. The API sends `x-issuer-key`;
 * `Authorization: Bearer <key>` is also accepted. The service binds 127.0.0.1.
 */
import type { Logger } from "@openrail/shared";
import { createHash, timingSafeEqual } from "node:crypto";
import { IssuerError } from "./errors.js";
import type { IssuerService } from "./service.js";

export interface HttpRequestHeaders {
  [name: string]: string | string[] | undefined;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export interface IssuerApp {
  handle(
    method: string,
    url: string,
    headers: HttpRequestHeaders,
    body: string,
  ): Promise<HttpResponse>;
}

export interface IssuerAppDeps {
  service: IssuerService;
  serviceKey: string;
  logger: Logger;
}

function header(headers: HttpRequestHeaders, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

/** Hash both sides so the comparison is constant-time regardless of length. */
export function isAuthorized(headers: HttpRequestHeaders, serviceKey: string): boolean {
  if (serviceKey === "") return false;
  const authorization = header(headers, "authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const provided = bearer ?? header(headers, "x-issuer-key");
  if (provided === undefined || provided === "") return false;
  const expectedHash = createHash("sha256").update(serviceKey).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

function objectBody(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new IssuerError(400, "invalid_json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IssuerError(400, "invalid_json");
  }
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value === "") {
    throw new IssuerError(400, "invalid_request", `${name} must be a non-empty string`);
  }
  return value;
}

function numberField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new IssuerError(400, "invalid_request", `${name} must be an integer`);
  }
  return value;
}

function objectField(body: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = body[name];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IssuerError(400, "invalid_request", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function debtorField(body: Record<string, unknown>): { Near: string } | { Evm: string } | null {
  const value = body.debtor;
  if (value === null || value === undefined) return null;
  const debtor = objectField(body, "debtor");
  const near = debtor.Near;
  const evm = debtor.Evm;
  if (typeof near === "string" && near !== "") return { Near: near };
  if (typeof evm === "string" && evm !== "") return { Evm: evm };
  throw new IssuerError(400, "invalid_request", "debtor must be {Near} or {Evm}");
}

function hashField(body: Record<string, unknown>, name: string): string {
  const value = stringField(body, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new IssuerError(400, "invalid_request", `${name} must be 0x + 64 hex`);
  }
  return value;
}

function moneyField(body: Record<string, unknown>, name: string): string {
  const value = stringField(body, name);
  if (!/^\d+$/.test(value)) {
    throw new IssuerError(400, "invalid_request", `${name} must be a decimal string`);
  }
  return value;
}

export function createIssuerApp(deps: IssuerAppDeps): IssuerApp {
  return {
    async handle(method, url, headers, body): Promise<HttpResponse> {
      const path = url.split("?")[0] ?? url;
      if (!isAuthorized(headers, deps.serviceKey)) {
        return { status: 401, body: { error: { code: "unauthorized" } } };
      }
      if (method !== "POST") {
        return { status: 405, body: { error: { code: "method_not_allowed" } } };
      }

      try {
        const payload = objectBody(body);
        switch (path) {
          case "/issue/prepare":
            return {
              status: 200,
              body: await deps.service.prepareIssue(stringField(payload, "account_id")),
            };
          case "/issue": {
            const metadata = payload.metadata;
            if (
              metadata !== undefined &&
              metadata !== null &&
              (typeof metadata !== "object" || Array.isArray(metadata))
            ) {
              throw new IssuerError(400, "invalid_request", "metadata must be an object");
            }
            return {
              status: 200,
              body: await deps.service.issueFor({
                business: stringField(payload, "business"),
                kind: numberField(payload, "kind"),
                debtor: debtorField(payload),
                termsHash: hashField(payload, "termsHash"),
                amountDue: moneyField(payload, "amountDue"),
                dueDate: numberField(payload, "dueDate"),
                ...(metadata === undefined || metadata === null
                  ? {}
                  : { metadata: metadata as Record<string, unknown> }),
              }),
            };
          }
          case "/log_quote":
            return {
              status: 200,
              body: await deps.service.logQuote({
                tokenId: stringField(payload, "tokenId"),
                quoteId: stringField(payload, "quoteId"),
                depositAddress: stringField(payload, "depositAddress"),
                deadlineRequested: numberField(payload, "deadlineRequested"),
                refundTo: stringField(payload, "refundTo"),
                routeId: stringField(payload, "routeId"),
              }),
            };
          case "/ack/evm":
            return {
              status: 200,
              body: await deps.service.acknowledgeEvm({
                tokenId: stringField(payload, "tokenId"),
                chainId: numberField(payload, "chainId"),
                signature: stringField(payload, "signature"),
              }),
            };
          default:
            return { status: 404, body: { error: { code: "not_found" } } };
        }
      } catch (error) {
        if (error instanceof IssuerError) {
          return {
            status: error.status,
            body: { error: { code: error.code, message: error.message } },
          };
        }
        deps.logger.error(
          "issuer request failed",
          error instanceof Error ? error.message : String(error),
        );
        return { status: 502, body: { error: { code: "upstream_error" } } };
      }
    },
  };
}
