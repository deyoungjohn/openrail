import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies Shopify's `X-Shopify-Hmac-Sha256` header (base64-encoded HMAC-SHA256 of the raw body).
 * Verified against: https://shopify.dev/docs/apps/build/webhooks/subscribe/https#step-5-verify-the-webhook
 */
export function signShopifyWebhookHmac(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

export function verifyShopifyWebhookHmac(
  rawBody: string,
  hmacHeader: string | undefined,
  secret: string,
): boolean {
  if (!hmacHeader || !secret) return false;
  const expected = Buffer.from(signShopifyWebhookHmac(rawBody, secret), "utf8");
  const actual = Buffer.from(hmacHeader.trim(), "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Signs and verifies `Openrail-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`.
 * Matches `services/api/src/webhooks.ts:signWebhook`.
 */
export function signOpenrailWebhook(secret: string, timestamp: number, rawBody: string): string {
  const sig = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

export function verifyOpenrailWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secrets: readonly string[],
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader || secrets.length === 0) return false;
  let timestamp: number | undefined;
  const v1Sigs: string[] = [];

  for (const part of signatureHeader.split(",")) {
    const [rawKey, rawVal] = part.trim().split("=", 2);
    if (!rawKey || !rawVal) continue;
    if (rawKey === "t") {
      if (!/^\d+$/.test(rawVal)) return false;
      timestamp = Number(rawVal);
    } else if (rawKey === "v1") {
      if (/^[0-9a-fA-F]{64}$/.test(rawVal)) {
        v1Sigs.push(rawVal.toLowerCase());
      }
    }
  }

  if (timestamp === undefined || v1Sigs.length === 0) return false;
  if (Math.abs(nowSec - timestamp) > toleranceSec) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  for (const secret of secrets) {
    if (!secret) continue;
    const expectedHex = createHmac("sha256", secret)
      .update(signedPayload, "utf8")
      .digest("hex")
      .toLowerCase();
    const expectedBuf = Buffer.from(expectedHex, "utf8");
    for (const candidate of v1Sigs) {
      const candidateBuf = Buffer.from(candidate, "utf8");
      if (
        expectedBuf.length === candidateBuf.length &&
        timingSafeEqual(expectedBuf, candidateBuf)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Signed, single-use order token for `GET /shopify/pay/:order_token`.
 */
export interface OrderPayTokenPayload {
  orderGid: string;
  orderName: string;
  shopDomain: string;
  nonce: string;
  exp: number;
}

export function createOrderPayToken(payload: OrderPayTokenPayload, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(encodedPayload, "utf8").digest("base64url");
  return `${encodedPayload}.${sig}`;
}

export type VerifyTokenResult =
  | { ok: true; payload: OrderPayTokenPayload }
  | { ok: false; code: "invalid_order_token" | "expired_order_token" };

export function verifyOrderPayToken(
  token: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): VerifyTokenResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, code: "invalid_order_token" };
  const [encodedPayload, providedSig] = parts;
  if (!encodedPayload || !providedSig || !secret) {
    return { ok: false, code: "invalid_order_token" };
  }

  const expectedSig = createHmac("sha256", secret)
    .update(encodedPayload, "utf8")
    .digest("base64url");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  const providedBuf = Buffer.from(providedSig, "utf8");
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, code: "invalid_order_token" };
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<OrderPayTokenPayload>;
    if (
      typeof parsed.orderGid !== "string" ||
      typeof parsed.orderName !== "string" ||
      typeof parsed.shopDomain !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return { ok: false, code: "invalid_order_token" };
    }
    if (nowSec > parsed.exp) {
      return { ok: false, code: "expired_order_token" };
    }
    return {
      ok: true,
      payload: {
        orderGid: parsed.orderGid,
        orderName: parsed.orderName,
        shopDomain: parsed.shopDomain,
        nonce: parsed.nonce,
        exp: parsed.exp,
      },
    };
  } catch {
    return { ok: false, code: "invalid_order_token" };
  }
}

export class OrderTokenStore {
  private readonly consumedNonces = new Set<string>();

  /**
   * Consumes a verified token nonce. Returns `true` on first use and `false` if already used.
   */
  consume(nonce: string): boolean {
    if (this.consumedNonces.has(nonce)) return false;
    this.consumedNonces.add(nonce);
    return true;
  }

  has(nonce: string): boolean {
    return this.consumedNonces.has(nonce);
  }
}


export type SessionTokenResult = { ok: true } | { ok: false; reason: string };

/**
 * Verifies the session token a checkout UI extension sends (`shopify.sessionToken.get()`): a JWT signed HS256 with the
 * app's client secret, with `exp`, `aud` (the app's client id) and `dest` (the shop). Shopify's guidance: a token lives
 * five minutes and is asked for just before each call.
 */
export function verifyShopifySessionToken(
  token: string,
  clientSecret: string,
  clientId: string,
  shopDomain: string,
  nowSec: number,
): SessionTokenResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [head, body, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", clientSecret).update(`${head}.${body}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "bad_signature" };
  let header: { alg?: unknown };
  let claims: { exp?: unknown; aud?: unknown; dest?: unknown };
  try {
    header = JSON.parse(Buffer.from(head, "base64url").toString("utf8")) as { alg?: unknown };
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as typeof claims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "HS256") return { ok: false, reason: "bad_algorithm" };
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) return { ok: false, reason: "expired" };
  if (claims.aud !== clientId) return { ok: false, reason: "wrong_app" };
  let host: string;
  try {
    host = new URL(String(claims.dest)).host;
  } catch {
    return { ok: false, reason: "wrong_shop" };
  }
  if (host !== shopDomain) return { ok: false, reason: "wrong_shop" };
  return { ok: true };
}
