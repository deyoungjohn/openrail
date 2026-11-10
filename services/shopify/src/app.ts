import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ShopifyAdminClient, ShopifyOrder } from "./admin-client.js";
import {
  OrderTokenStore,
  createOrderPayToken,
  verifyOpenrailWebhookSignature,
  verifyOrderPayToken,
  verifyShopifySessionToken,
  verifyShopifyWebhookHmac,
} from "./hmac.js";
import type {
  ShopifyOffsitePaymentSessionRequest,
  ShopifyPaymentsAppClient,
} from "./payments-app-client.js";

export interface ShopifyAppEnv {
  SHOPIFY_SHOP_DOMAIN: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_WEBHOOK_SECRET?: string;
  SHOPIFY_ADMIN_ACCESS_TOKEN?: string;
  SHOPIFY_ORDER_TOKEN_SECRET: string;
  SHOPIFY_PORT?: string;
  SHOPIFY_PRE_ORDER_LINK?: string;
  OPENRAIL_API_URL: string;
  OPENRAIL_API_KEY: string;
  OPENRAIL_WEBHOOK_SECRET: string;
  APP_BASE_URL: string;
}

const BASE_REQUIRED_ENV_KEYS: ReadonlyArray<keyof ShopifyAppEnv> = [
  "SHOPIFY_SHOP_DOMAIN",
  "SHOPIFY_ORDER_TOKEN_SECRET",
  "OPENRAIL_API_URL",
  "OPENRAIL_API_KEY",
  "OPENRAIL_WEBHOOK_SECRET",
  "APP_BASE_URL",
];

/**
 * Normalises SHOPIFY_SHOP_DOMAIN: trims, lower-cases, strips scheme, path, query/hash,
 * and validates that the result is a valid bare host. Refuses invalid host values with
 * named error INVALID_ENV: SHOPIFY_SHOP_DOMAIN without leaking the value (Hard Rule 1).
 */
export function normalizeShopDomain(rawDomain: string): string {
  let val = rawDomain.trim().toLowerCase();
  if (val.startsWith("https://")) {
    val = val.slice("https://".length);
  } else if (val.startsWith("http://")) {
    val = val.slice("http://".length);
  }
  const slashIdx = val.indexOf("/");
  if (slashIdx !== -1) {
    val = val.slice(0, slashIdx);
  }
  const qIdx = val.indexOf("?");
  if (qIdx !== -1) {
    val = val.slice(0, qIdx);
  }
  const hashIdx = val.indexOf("#");
  if (hashIdx !== -1) {
    val = val.slice(0, hashIdx);
  }
  val = val.trim();
  const HOST_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
  if (!val || !HOST_REGEX.test(val)) {
    throw new Error("INVALID_ENV: SHOPIFY_SHOP_DOMAIN");
  }
  return val;
}

/**
 * Loads environment variables from an optional env file (parsed line-by-line, CRLF-safe, never sourced)
 * or `process.env`. Never logs or prints secret values (Hard Rule 1).
 * Exits with `MISSING_ENV: <NAME>` if any required variable is absent.
 */
export function loadShopifyAppEnv(
  envFilePath?: string,
  envSource: Record<string, string | undefined> = process.env,
): ShopifyAppEnv {
  const fileValues: Record<string, string> = {};
  if (envFilePath && existsSync(envFilePath)) {
    const raw = readFileSync(envFilePath, "utf8");
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      fileValues[key] = val;
    }
  }

  const getVal = (k: keyof ShopifyAppEnv): string | undefined => {
    const v = fileValues[k] ?? envSource[k];
    return v && v.trim() !== "" ? v.trim() : undefined;
  };

  const out: Partial<ShopifyAppEnv> = {};
  for (const key of BASE_REQUIRED_ENV_KEYS) {
    const val = getVal(key);
    if (!val) {
      throw new Error(`MISSING_ENV: ${key}`);
    }
    if (key === "SHOPIFY_SHOP_DOMAIN") {
      out.SHOPIFY_SHOP_DOMAIN = normalizeShopDomain(val);
    } else {
      out[key] = val;
    }
  }

  // The pay links are built from APP_BASE_URL: a bare host would make them relative (the browser resolves them
  // against the shop's own domain and lands on Shopify's 404, found live 11 Nov), so refuse it at startup.
  const appBase = String(out.APP_BASE_URL ?? "").trim();
  if (!/^https?:\/\/[^/\s]+/i.test(appBase)) {
    throw new Error("INVALID_ENV: APP_BASE_URL (must start with https://)");
  }
  out.APP_BASE_URL = appBase.replace(/\/+$/, "");

  const staticToken = getVal("SHOPIFY_ADMIN_ACCESS_TOKEN");
  const clientId = getVal("SHOPIFY_CLIENT_ID");
  const clientSecret = getVal("SHOPIFY_CLIENT_SECRET");

  if (!staticToken) {
    if (!clientId) {
      throw new Error("MISSING_ENV: SHOPIFY_CLIENT_ID");
    }
    if (!clientSecret) {
      throw new Error("MISSING_ENV: SHOPIFY_CLIENT_SECRET");
    }
  }

  if (staticToken) out.SHOPIFY_ADMIN_ACCESS_TOKEN = staticToken;
  if (clientId) out.SHOPIFY_CLIENT_ID = clientId;
  if (clientSecret) out.SHOPIFY_CLIENT_SECRET = clientSecret;

  const webhookSecret = getVal("SHOPIFY_WEBHOOK_SECRET") ?? clientSecret;
  if (webhookSecret) {
    out.SHOPIFY_WEBHOOK_SECRET = webhookSecret;
  }

  const port = getVal("SHOPIFY_PORT");
  if (port) out.SHOPIFY_PORT = port;

  const preOrder = getVal("SHOPIFY_PRE_ORDER_LINK");
  if (preOrder) out.SHOPIFY_PRE_ORDER_LINK = preOrder;

  return out as ShopifyAppEnv;
}

export interface CreateCheckoutRequest {
  order_ref: string;
  amount_usd: string;
  currency?: string;
  expires_in_minutes?: number;
  return_url?: string;
  cancel_url?: string;
  fee_mode?: "absorb" | "pass_to_customer";
  items?: Array<{
    name: string;
    quantity: number;
    unit_price_usd?: string;
  }>;
}

export interface CheckoutCreatedResponse {
  id: string;
  token_id: string;
  order_ref: string;
  amount_usd: string;
  subtotal_usd?: string;
  fee_usd?: string;
  total_usd?: string;
  fee_mode?: "absorb" | "pass_to_customer";
  amount_due?: string;
  pay_url: string;
  return_url?: string | null;
  cancel_url?: string | null;
  expires_at: string;
  status: string;
  paid_usd?: string;
  remaining_usd?: string;
  booking_tx?: string;
}

export interface CheckoutApiPort {
  createCheckout(
    req: CreateCheckoutRequest,
    idempotencyKey: string,
  ): Promise<{ status: number; checkout: CheckoutCreatedResponse }>;
  getCheckoutByOrderRef?(
    orderRef: string,
  ): Promise<CheckoutCreatedResponse | null>;
}

export function createHttpCheckoutApiPort(
  apiUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): CheckoutApiPort {
  const baseUrl = apiUrl.replace(/\/+$/, "");
  return {
    async createCheckout(req, idempotencyKey) {
      const response = await fetchImpl(`${baseUrl}/v1/checkouts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(req),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const errObj = (body.error ?? {}) as { code?: string; message?: string };
        const error = new Error(
          errObj.message ?? `Openrail API error (${response.status})`,
        ) as Error & { status?: number; code?: string };
        error.status = response.status;
        error.code = errObj.code ?? "checkout_api_error";
        throw error;
      }
      return {
        status: response.status,
        checkout: body as unknown as CheckoutCreatedResponse,
      };
    },
    async getCheckoutByOrderRef(orderRefPrefix: string) {
      const prefix = orderRefPrefix.endsWith("-") ? orderRefPrefix : `${orderRefPrefix}-`;
      let cursor: string | undefined = undefined;
      const maxPages = 5;
      for (let page = 0; page < maxPages; page++) {
        const url: string = cursor
          ? `${baseUrl}/v1/checkouts?limit=100&cursor=${encodeURIComponent(cursor)}`
          : `${baseUrl}/v1/checkouts?limit=100`;
        const response = await fetchImpl(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });
        if (!response.ok) return null;
        const body = (await response.json()) as {
          data?: CheckoutCreatedResponse[];
          has_more?: boolean;
          next_cursor?: string | null;
        };
        const items = Array.isArray(body.data) ? body.data : [];
        const match = items.find(
          (item) => item.order_ref === orderRefPrefix || item.order_ref.startsWith(prefix),
        );
        if (match) {
          return match;
        }
        if (!body.has_more || !body.next_cursor) {
          break;
        }
        cursor = body.next_cursor;
      }
      return null;
    },
  };
}

export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  rawBody: string;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body: Record<string, unknown> & {
    error?: { code: string; message: string };
  };
}

interface OrderBinding {
  orderGid: string;
  numericId?: string;
  orderName: string;
  orderRef: string;
  checkoutId: string;
  expectedTotalUsd: string;
  paymentSessionGid?: string;
  checkoutToken?: string;
  payUrl?: string;
  paid?: boolean;
  paidUsd?: string;
  remainingUsd?: string;
  status?: string;
  bookingTx?: string;
  summary?: string;
  confirmationNumber?: string;
  gateways?: string[];
  currency?: string;
}

function getHeader(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export interface NormalizedOrderId {
  numericId: string;
  orderGid: string;
}

export function parseAndNormalizeOrderId(raw: string | null | undefined): NormalizedOrderId | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const gidMatch = /^gid:\/\/shopify\/(?:Order|OrderIdentity)\/([a-zA-Z0-9_-]+)$/.exec(trimmed);
  if (gidMatch && gidMatch[1]) {
    const id = gidMatch[1];
    return {
      numericId: id,
      orderGid: `gid://shopify/Order/${id}`,
    };
  }

  if (/^\d+$/.test(trimmed)) {
    return {
      numericId: trimmed,
      orderGid: `gid://shopify/Order/${trimmed}`,
    };
  }

  return null;
}


function extractNumericOrderId(orderGid: string): string {
  const parsed = parseAndNormalizeOrderId(orderGid);
  if (parsed) return parsed.numericId;
  const match = /(\d+)$/.exec(orderGid) ?? /([a-zA-Z0-9_-]+)$/.exec(orderGid);
  return match?.[1] ?? orderGid.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sanitizeOrderRef(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 64);
}

function formatBaseUnitsUsd(unitsRaw: unknown): string {
  if (typeof unitsRaw !== "string" && typeof unitsRaw !== "number") return "0.00";
  const str = String(unitsRaw);
  if (!/^\d+$/.test(str)) return str;
  const units = BigInt(str);
  const cents = (units + 5_000n) / 10_000n;
  const whole = cents / 100n;
  const rem = cents % 100n;
  return `${whole.toString()}.${rem.toString().padStart(2, "0")}`;
}

function toCents(usd: string | undefined): number {
  if (!usd) return 0;
  const parsed = Number(usd);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

async function appendOrderNote(
  adminClient: ShopifyAdminClient,
  order: ShopifyOrder,
  line: string,
): Promise<void> {
  const existing = order.note?.trim() ?? "";
  const updated = existing ? `${existing}\n${line}` : line;
  await adminClient.updateOrderNote(order.id, updated);
}

function matchesOrderConfirmation(
  order: ShopifyOrder,
  confirmation?: string,
): boolean {
  if (!confirmation || typeof confirmation !== "string") return false;
  const trimmed = confirmation.trim();
  if (!trimmed) return false;
  if (
    order.confirmationNumber &&
    order.confirmationNumber.toLowerCase() === trimmed.toLowerCase()
  ) {
    return true;
  }
  if (
    order.name &&
    (order.name.toLowerCase() === trimmed.toLowerCase() ||
      order.name.replace(/^#/, "").toLowerCase() === trimmed.toLowerCase())
  ) {
    return true;
  }
  if (
    order.statusPageUrl &&
    order.statusPageUrl.toLowerCase().includes(trimmed.toLowerCase())
  ) {
    return true;
  }
  return false;
}

function matchesBindingConfirmation(
  binding: OrderBinding,
  confirmation?: string,
): boolean {
  if (!confirmation || typeof confirmation !== "string") return false;
  const trimmed = confirmation.trim().toLowerCase();
  if (!trimmed) return false;
  if (
    binding.confirmationNumber &&
    binding.confirmationNumber.trim().toLowerCase() === trimmed
  ) {
    return true;
  }
  if (
    binding.orderName &&
    (binding.orderName.trim().toLowerCase() === trimmed ||
      binding.orderName.replace(/^#/, "").trim().toLowerCase() === trimmed)
  ) {
    return true;
  }
  if (binding.numericId && binding.numericId.trim().toLowerCase() === trimmed) {
    return true;
  }
  return false;
}

function isProtectedCustomerDataError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /not approved to access the order object/i.test(msg) ||
    /protected-customer-data/i.test(msg) ||
    /protected customer data/i.test(msg)
  );
}

export interface CreateShopifyAppOptions {
  env: ShopifyAppEnv;
  adminClient: ShopifyAdminClient;
  paymentsAppClient?: ShopifyPaymentsAppClient;
  checkoutApi: CheckoutApiPort;
  tokenStore?: OrderTokenStore;
  clock?: () => number;
  logger?: (msg: string) => void;
}

export function createShopifyApp(options: CreateShopifyAppOptions) {
  const { env, adminClient, paymentsAppClient, checkoutApi } = options;
  const tokenStore = options.tokenStore ?? new OrderTokenStore();
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  const logger = options.logger ?? console.log;

  // Fetch-once bindings & deduplication stores
  const bindingsByOrderRef = new Map<string, OrderBinding>();
  const bindingsByCheckoutId = new Map<string, OrderBinding>();
  const bindingsByCheckoutToken = new Map<string, OrderBinding>();
  const bindingsByOrderGid = new Map<string, OrderBinding>();
  const processedEventIds = new Set<string>();
  const settledOrderGids = new Set<string>();
  const checkoutRequestsByShop = new Map<string, number[]>();
  const firstSeenOrderRequests = new Map<string, number>();
  const nonOpenrailOrders = new Map<string, { numericId: string; gateways: string[] }>();
  const RATE_LIMIT_WINDOW_SEC = 60;
  const RATE_LIMIT_MAX_REQUESTS = 60;

  function checkRateLimit(shopKey: string, nowSec: number): boolean {
    const timestamps = checkoutRequestsByShop.get(shopKey) ?? [];
    const recent = timestamps.filter((t) => t > nowSec - RATE_LIMIT_WINDOW_SEC);
    if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
      return false;
    }
    recent.push(nowSec);
    checkoutRequestsByShop.set(shopKey, recent);
    return true;
  }

  const lastRefusalLogTimeByReason = new Map<string, number>();

  function logSessionTokenRefusal(reason: string, nowSec: number, detail?: string) {
    const lastSec = lastRefusalLogTimeByReason.get(reason);
    if (lastSec === undefined || nowSec - lastSec >= 60) {
      lastRefusalLogTimeByReason.set(reason, nowSec);
      if (detail) console.warn("[shopify] session token refused:", reason, detail);
      else console.warn("[shopify] session token refused:", reason);
    }
  }

  async function handleInstallCheck(): Promise<HttpResponse> {
    const shop = await adminClient.getShop();
    if (shop.currencyCode !== "USD") {
      return {
        status: 422,
        body: {
          error: {
            code: "unsupported_currency",
            message: `Openrail requires a USD Shopify store currency (found ${shop.currencyCode}).`,
          },
        },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        shop: {
          name: shop.name,
          currencyCode: shop.currencyCode,
          myshopifyDomain: shop.myshopifyDomain,
        },
      },
    };
  }

  async function handleOrdersCreateWebhook(req: HttpRequest): Promise<HttpResponse> {
    const hmacHeader = getHeader(req.headers, "x-shopify-hmac-sha256");
    const secret = env.SHOPIFY_WEBHOOK_SECRET || env.SHOPIFY_CLIENT_SECRET || "";
    if (!verifyShopifyWebhookHmac(req.rawBody, hmacHeader, secret)) {
      logger("[shopify] webhook refused: invalid signature");
      return {
        status: 401,
        body: {
          error: {
            code: "invalid_shopify_hmac",
            message: "Invalid X-Shopify-Hmac-Sha256 webhook signature",
          },
        },
      };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody) as Record<string, unknown>;
    } catch {
      return {
        status: 400,
        body: { error: { code: "invalid_json", message: "Invalid JSON body" } },
      };
    }

    const rawOrderGid =
      typeof payload.admin_graphql_api_id === "string"
        ? payload.admin_graphql_api_id
        : String(payload.id ?? "");
    const parsedOrder = parseAndNormalizeOrderId(rawOrderGid) ?? {
      numericId: String(payload.id ?? ""),
      orderGid: `gid://shopify/Order/${String(payload.id ?? "")}`,
    };
    const orderGid = parsedOrder.orderGid;
    const numericId = parsedOrder.numericId;
    const orderName = typeof payload.name === "string" ? payload.name : orderGid;
    const shopDomain =
      getHeader(req.headers, "x-shopify-shop-domain") ?? env.SHOPIFY_SHOP_DOMAIN;

    const gateways = Array.isArray(payload.payment_gateway_names)
      ? (payload.payment_gateway_names as unknown[]).map(String)
      : [];
    const usesOpenrail = gateways.some((g) => /openrail|stablecoin/i.test(g));
    if (!usesOpenrail) {
      nonOpenrailOrders.set(orderGid, { numericId, gateways });
      nonOpenrailOrders.set(numericId, { numericId, gateways });
      return { status: 200, body: { ignored: true, reason: "non_openrail_gateway" } };
    }

    const currency = (
      typeof payload.currency === "string"
        ? payload.currency
        : typeof payload.presentment_currency === "string"
        ? payload.presentment_currency
        : "USD"
    ).trim().toUpperCase();

    if (currency !== "USD") {
      return {
        status: 422,
        body: {
          error: {
            code: "unsupported_currency",
            message: `Openrail requires USD currency (received ${currency}).`,
          },
        },
      };
    }

    const rawTotal =
      payload.current_total_price ??
      payload.total_price ??
      payload.total_outstanding;
    let totalUsd: string | undefined;
    if (rawTotal !== undefined) {
      const totalAmount = Number(rawTotal);
      if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
        return {
          status: 400,
          body: {
            error: {
              code: "invalid_total",
              message: "Order total must be greater than zero",
            },
          },
        };
      }
      totalUsd = totalAmount.toFixed(2);
    }
    let confirmationNumber =
      typeof payload.confirmation_number === "string"
        ? payload.confirmation_number
        : undefined;

    if (!totalUsd || !confirmationNumber) {
      try {
        const orderPreview = await adminClient.getOrder(orderGid);
        if (!totalUsd) {
          const previewAmt =
            orderPreview?.currentTotalPriceSet?.shopMoney?.amount ??
            orderPreview?.totalOutstandingSet?.shopMoney?.amount;
          if (previewAmt) totalUsd = Number(previewAmt).toFixed(2);
        }
        if (!confirmationNumber && orderPreview?.confirmationNumber) {
          confirmationNumber = orderPreview.confirmationNumber;
        }
      } catch {
        // Protected customer data or not found; proceed with webhook fields
      }
    }

    const checkoutToken =
      typeof payload.checkout_token === "string" ? payload.checkout_token : undefined;
    let matchedBinding: OrderBinding | undefined;
    if (checkoutToken) {
      if (bindingsByCheckoutToken.has(checkoutToken)) {
        matchedBinding = bindingsByCheckoutToken.get(checkoutToken);
      } else if (checkoutApi.getCheckoutByOrderRef) {
        // Defect 3: Reconstruct from Openrail checkout on cache miss (e.g. process restart)
        const orderRefPrefix = `shopify-chk-${checkoutToken}`;
        const recovered = await checkoutApi.getCheckoutByOrderRef(orderRefPrefix);
        if (recovered) {
          const isPaid = recovered.status === "paid";
          const isPartial = recovered.status === "partial";
          const expectedTotal = recovered.total_usd ?? recovered.amount_usd;
          const paidUsd = isPaid
            ? expectedTotal
            : isPartial
            ? recovered.paid_usd ?? "0.00"
            : "0.00";
          const remainingUsd = isPaid
            ? "0.00"
            : isPartial
            ? recovered.remaining_usd ?? ((toCents(expectedTotal) - toCents(paidUsd)) / 100).toFixed(2)
            : expectedTotal;

          matchedBinding = {
            orderGid,
            numericId,
            orderName,
            orderRef: recovered.order_ref,
            checkoutId: recovered.id,
            expectedTotalUsd: expectedTotal,
            checkoutToken,
            payUrl: recovered.pay_url,
            paid: isPaid,
            paidUsd,
            remainingUsd,
            status: recovered.status,
            bookingTx: recovered.booking_tx,
            confirmationNumber,
            gateways,
            currency: "USD",
          };
          bindingsByCheckoutToken.set(checkoutToken, matchedBinding);
          bindingsByCheckoutId.set(recovered.id, matchedBinding);
          bindingsByOrderRef.set(recovered.order_ref, matchedBinding);
          bindingsByOrderGid.set(orderGid, matchedBinding);
          bindingsByOrderGid.set(numericId, matchedBinding);
        }
      }
      if (matchedBinding) {
        matchedBinding.orderGid = orderGid;
        matchedBinding.numericId = numericId;
        matchedBinding.orderName = orderName;
        if (confirmationNumber) matchedBinding.confirmationNumber = confirmationNumber;
        matchedBinding.gateways = gateways;
        matchedBinding.currency = "USD";
        bindingsByOrderGid.set(orderGid, matchedBinding);
        bindingsByOrderGid.set(numericId, matchedBinding);
      }
    }

    const orderRef = sanitizeOrderRef(`shopify-${numericId}`);
    if (!matchedBinding) {
      matchedBinding =
        bindingsByOrderGid.get(orderGid) ??
        bindingsByOrderGid.get(numericId) ??
        bindingsByOrderRef.get(orderRef);
      if (!matchedBinding && checkoutApi.getCheckoutByOrderRef) {
        const recovered = await checkoutApi.getCheckoutByOrderRef(orderRef);
        if (recovered) {
          const isPaid = recovered.status === "paid";
          const isPartial = recovered.status === "partial";
          const expectedTotal = recovered.total_usd ?? recovered.amount_usd;
          const paidUsd = isPaid
            ? expectedTotal
            : isPartial
            ? recovered.paid_usd ?? "0.00"
            : "0.00";
          const remainingUsd = isPaid
            ? "0.00"
            : isPartial
            ? recovered.remaining_usd ?? ((toCents(expectedTotal) - toCents(paidUsd)) / 100).toFixed(2)
            : expectedTotal;

          matchedBinding = {
            orderGid,
            numericId,
            orderName,
            orderRef: recovered.order_ref,
            checkoutId: recovered.id,
            expectedTotalUsd: expectedTotal,
            payUrl: recovered.pay_url,
            paid: isPaid,
            paidUsd,
            remainingUsd,
            status: recovered.status,
            bookingTx: recovered.booking_tx,
            confirmationNumber,
            gateways,
            currency: "USD",
          };
          bindingsByCheckoutId.set(recovered.id, matchedBinding);
          bindingsByOrderRef.set(recovered.order_ref, matchedBinding);
          bindingsByOrderGid.set(orderGid, matchedBinding);
          bindingsByOrderGid.set(numericId, matchedBinding);
        }
      }
    }

    if (!matchedBinding) {
      const isPaid = payload.financial_status === "paid";
      matchedBinding = {
        orderGid,
        numericId,
        orderName,
        orderRef,
        checkoutId: "",
        expectedTotalUsd: totalUsd ?? "0.00",
        checkoutToken,
        confirmationNumber,
        gateways,
        currency: "USD",
        paid: isPaid,
        paidUsd: isPaid ? (totalUsd ?? "0.00") : "0.00",
        remainingUsd: isPaid ? "0.00" : (totalUsd ?? "0.00"),
        status: isPaid ? "paid" : "unpaid",
      };
    } else {
      matchedBinding.orderGid = orderGid;
      matchedBinding.numericId = numericId;
      matchedBinding.orderName = orderName;
      if (confirmationNumber) matchedBinding.confirmationNumber = confirmationNumber;
      matchedBinding.gateways = gateways;
      matchedBinding.currency = "USD";
      if (totalUsd && (!matchedBinding.expectedTotalUsd || matchedBinding.expectedTotalUsd === "0.00")) {
        matchedBinding.expectedTotalUsd = totalUsd;
      }
    }

    bindingsByOrderGid.set(orderGid, matchedBinding);
    bindingsByOrderGid.set(numericId, matchedBinding);
    bindingsByOrderRef.set(orderRef, matchedBinding);
    if (checkoutToken) {
      bindingsByCheckoutToken.set(checkoutToken, matchedBinding);
    }

    logger(
      `[shopify] order ${numericId} bound from webhook (total ${matchedBinding.expectedTotalUsd})`,
    );

    if (matchedBinding.paid) {
      let order: ShopifyOrder | null = null;
      try {
        order = await adminClient.getOrder(orderGid);
      } catch (err) {
        if (isProtectedCustomerDataError(err)) {
          logger(
            `[shopify] cannot read order ${numericId}: the app is not approved for protected customer data; request access in the Dev Dashboard`,
          );
        }
      }

      const orderTotalUsd =
        order?.totalOutstandingSet?.shopMoney?.amount ?? matchedBinding.expectedTotalUsd;
      const paidUsd = matchedBinding.expectedTotalUsd;

      if (toCents(paidUsd) < toCents(orderTotalUsd)) {
        // UNDERPAID! Do NOT mark paid!
        const remainingUsd = ((toCents(orderTotalUsd) - toCents(paidUsd)) / 100).toFixed(2);
        try {
          await adminClient.addOrderTags(orderGid, ["openrail-partial"]);
          if (order) {
            await appendOrderNote(
              adminClient,
              order,
              `Openrail: partial payment received (${paidUsd} USD), ${remainingUsd} USD still due (checkout ${matchedBinding.checkoutId}).`,
            );
          }
        } catch (err) {
          if (!isProtectedCustomerDataError(err)) throw err;
        }
        logger(
          `[shopify] order ${orderGid} placed for checkout_token ${checkoutToken} was underpaid (paid ${paidUsd} USD, order total ${orderTotalUsd} USD)`,
        );
      } else {
        // Full payment
        if (!settledOrderGids.has(orderGid)) {
          try {
            await adminClient.markOrderAsPaid(orderGid);
            settledOrderGids.add(orderGid);
            await adminClient.addOrderTags(orderGid, ["openrail-paid"]);
            if (order) {
              const txDetail = matchedBinding.bookingTx
                ? `, booking tx ${matchedBinding.bookingTx}`
                : "";
              await appendOrderNote(
                adminClient,
                order,
                `Openrail: payment booked in full (${matchedBinding.expectedTotalUsd} USD, checkout ${matchedBinding.checkoutId}${txDetail}).`,
              );
            }
          } catch (err) {
            if (isProtectedCustomerDataError(err)) {
              logger(
                `[shopify] cannot mark order ${numericId} paid: the app is not approved for protected customer data; request access in the Dev Dashboard`,
              );
            } else {
              throw err;
            }
          }
        }
      }
    } else {
      logger(
        `[shopify] order ${orderGid} placed for checkout_token ${checkoutToken}, but invoice ${matchedBinding.checkoutId} is unpaid`,
      );
    }

    const token = createOrderPayToken(
      {
        orderGid,
        orderName,
        shopDomain,
        nonce: randomUUID(),
        exp: clock() + 3600,
      },
      env.SHOPIFY_ORDER_TOKEN_SECRET,
    );

    const baseUrl = env.APP_BASE_URL.replace(/\/+$/, "");
    return {
      status: 200,
      body: {
        ok: true,
        order_gid: orderGid,
        order_name: orderName,
        pay_url: `${baseUrl}/shopify/pay/${encodeURIComponent(token)}`,
      },
    };
  }

  async function handleOrderPayRedirect(
    rawToken: string,
    _req: HttpRequest,
  ): Promise<HttpResponse> {
    const verified = verifyOrderPayToken(
      decodeURIComponent(rawToken),
      env.SHOPIFY_ORDER_TOKEN_SECRET,
      clock(),
    );
    if (!verified.ok) {
      return {
        status: 401,
        body: {
          error: {
            code: verified.code,
            message:
              verified.code === "expired_order_token"
                ? "This payment link has expired."
                : "Invalid order payment token.",
          },
        },
      };
    }

    if (!tokenStore.consume(verified.payload.nonce)) {
      return {
        status: 410,
        body: {
          error: {
            code: "order_token_already_used",
            message: "This single-use order token has already been redeemed.",
          },
        },
      };
    }

    // The Admin API refuses the Order object until the app is approved for protected customer data (found live 11 Nov).
    // Prefer the Admin API (it also gives the order's status page for the return links); when it refuses and the store's
    // orders/create webhook has already bound this order, the total comes from that binding (Shopify's own webhook,
    // never the browser) and no Admin API read is needed.
    const boundNumeric = extractNumericOrderId(verified.payload.orderGid);
    const bound =
      bindingsByOrderGid.get(verified.payload.orderGid) ?? bindingsByOrderGid.get(boundNumeric);
    const redirectFromBinding = async (b: OrderBinding): Promise<HttpResponse> => {
      if (b.paid || b.status === "paid") {
        return {
          status: 409,
          body: {
            error: { code: "order_already_paid", message: "This order is already marked as paid." },
          },
        };
      }
      if (!b.payUrl) {
        const boundRef = sanitizeOrderRef(`shopify-${boundNumeric}`);
        const { checkout: boundCheckout } = await checkoutApi.createCheckout(
          {
            order_ref: boundRef,
            amount_usd: b.expectedTotalUsd,
            currency: "USD",
            expires_in_minutes: 60,
          },
          `shopify-order-${boundNumeric}-${b.expectedTotalUsd}`,
        );
        b.checkoutId = boundCheckout.id;
        b.payUrl = boundCheckout.pay_url;
        b.orderRef = boundRef;
        bindingsByOrderRef.set(boundRef, b);
        bindingsByCheckoutId.set(boundCheckout.id, b);
      }
      return {
        status: 302,
        headers: { location: b.payUrl },
        body: { redirect_url: b.payUrl, checkout_id: b.checkoutId, order_ref: b.orderRef },
      };
    };

    // Rule: ALWAYS read the outstanding total from the Shopify Admin GraphQL API, NEVER from the browser
    let order: ShopifyOrder;
    try {
      order = await adminClient.getOrder(verified.payload.orderGid);
    } catch (error) {
      if (!bound) throw error;
      console.warn(
        `[shopify] pay redirect: could not read order ${boundNumeric} from the Admin API (${error instanceof Error ? error.message : "unknown error"}); using the webhook binding`,
      );
      return redirectFromBinding(bound);
    }
    const shopMoney = order.totalOutstandingSet.shopMoney;
    if (order.currencyCode !== "USD" || shopMoney.currencyCode !== "USD") {
      return {
        status: 422,
        body: {
          error: {
            code: "unsupported_currency",
            message: `Order currency must be USD (received ${shopMoney.currencyCode}).`,
          },
        },
      };
    }

    if (order.fullyPaid || order.displayFinancialStatus === "PAID") {
      return {
        status: 409,
        body: {
          error: {
            code: "order_already_paid",
            message: "This order is already marked as paid.",
          },
        },
      };
    }

    const numericId = extractNumericOrderId(order.id);
    const orderRef = sanitizeOrderRef(`shopify-${numericId}`);
    const amountUsd = Number(shopMoney.amount).toFixed(2);
    const idempotencyKey = `shopify-order-${numericId}-${amountUsd}`;

    const items = order.lineItems.map((item) => ({
      name: item.title,
      quantity: item.quantity,
      ...(item.unitPriceUsd ? { unit_price_usd: item.unitPriceUsd } : {}),
    }));

    const { checkout } = await checkoutApi.createCheckout(
      {
        order_ref: orderRef,
        amount_usd: amountUsd,
        currency: "USD",
        expires_in_minutes: 60,
        return_url: order.statusPageUrl,
        cancel_url: order.statusPageUrl,
        ...(items.length > 0 ? { items } : {}),
      },
      idempotencyKey,
    );

    const binding: OrderBinding = {
      orderGid: order.id,
      orderName: order.name,
      orderRef,
      checkoutId: checkout.id,
      expectedTotalUsd: checkout.total_usd ?? checkout.amount_usd,
    };
    bindingsByOrderRef.set(orderRef, binding);
    bindingsByCheckoutId.set(checkout.id, binding);

    return {
      status: 302,
      headers: {
        location: checkout.pay_url,
      },
      body: {
        redirect_url: checkout.pay_url,
        checkout_id: checkout.id,
        order_ref: orderRef,
      },
    };
  }

  async function handleOffsitePaymentSession(req: HttpRequest): Promise<HttpResponse> {
    const hmacHeader = getHeader(req.headers, "x-shopify-hmac-sha256");
    const secret = env.SHOPIFY_WEBHOOK_SECRET || env.SHOPIFY_CLIENT_SECRET || "";
    if (!verifyShopifyWebhookHmac(req.rawBody, hmacHeader, secret)) {
      return {
        status: 401,
        body: {
          error: {
            code: "invalid_shopify_hmac",
            message: "Invalid signature on payment session request",
          },
        },
      };
    }

    let sessionReq: ShopifyOffsitePaymentSessionRequest;
    try {
      sessionReq = JSON.parse(req.rawBody) as ShopifyOffsitePaymentSessionRequest;
    } catch {
      return {
        status: 400,
        body: { error: { code: "invalid_json", message: "Invalid JSON body" } },
      };
    }

    if (sessionReq.currency !== "USD") {
      return {
        status: 422,
        body: {
          error: {
            code: "unsupported_currency",
            message: `Only USD payment sessions are supported (got ${sessionReq.currency}).`,
          },
        },
      };
    }

    const orderRef = sanitizeOrderRef(`shopify-group-${sessionReq.group || sessionReq.id}`);
    const amountUsd = Number(sessionReq.amount).toFixed(2);
    const idempotencyKey = `shopify-session-${sessionReq.group || sessionReq.id}`;

    const { checkout } = await checkoutApi.createCheckout(
      {
        order_ref: orderRef,
        amount_usd: amountUsd,
        currency: "USD",
        expires_in_minutes: 60,
        ...(sessionReq.cancel_url
          ? { return_url: sessionReq.cancel_url, cancel_url: sessionReq.cancel_url }
          : {}),
      },
      idempotencyKey,
    );

    const binding: OrderBinding = {
      orderGid: sessionReq.order_gid ?? `gid://shopify/Order/6001002003`,
      orderName: orderRef,
      orderRef,
      checkoutId: checkout.id,
      expectedTotalUsd: checkout.total_usd ?? checkout.amount_usd,
      paymentSessionGid: sessionReq.gid,
    };
    bindingsByOrderRef.set(orderRef, binding);
    bindingsByCheckoutId.set(checkout.id, binding);

    return {
      status: 200,
      body: {
        redirect_url: checkout.pay_url,
        checkout_id: checkout.id,
        order_ref: orderRef,
      },
    };
  }

  async function handleOpenrailWebhook(req: HttpRequest): Promise<HttpResponse> {
    const sigHeader = getHeader(req.headers, "openrail-signature");
    const secrets = env.OPENRAIL_WEBHOOK_SECRET.split(",").map((s) => s.trim());
    if (!verifyOpenrailWebhookSignature(req.rawBody, sigHeader, secrets, 300, clock())) {
      return {
        status: 401,
        body: {
          error: {
            code: "invalid_signature",
            message: "Invalid or expired Openrail-Signature header",
          },
        },
      };
    }

    let event: {
      id: string;
      type: string;
      created: number;
      data: Record<string, unknown>;
    };
    try {
      event = JSON.parse(req.rawBody) as typeof event;
    } catch {
      return {
        status: 400,
        body: { error: { code: "invalid_json", message: "Invalid JSON body" } },
      };
    }

    if (!event.id || !event.type || typeof event.data !== "object" || event.data === null) {
      return {
        status: 400,
        body: { error: { code: "invalid_event", message: "Missing event id, type, or data" } },
      };
    }

    // Deduplicate per Openrail event ID (shopify_mark_paid_idempotent)
    if (processedEventIds.has(event.id)) {
      return {
        status: 200,
        body: { ok: true, duplicate: true, event_id: event.id },
      };
    }

    const data = event.data;
    const tokenId = typeof data.token_id === "string" ? data.token_id : undefined;
    const orderRef = typeof data.order_ref === "string" ? data.order_ref : undefined;

    const binding =
      (orderRef ? bindingsByOrderRef.get(orderRef) : undefined) ??
      (tokenId ? bindingsByCheckoutId.get(tokenId) : undefined);

    if (!binding) {
      return {
        status: 404,
        body: {
          error: {
            code: "order_binding_not_found",
            message: "No Shopify order binding found for checkout event",
          },
        },
      };
    }

    // Fetch-once optimization: if this order is already settled and event is paid/accepted, skip network call
    if (
      binding.orderGid &&
      settledOrderGids.has(binding.orderGid) &&
      (event.type === "checkout.paid" || event.type === "checkout.accepted")
    ) {
      processedEventIds.add(event.id);
      return {
        status: 200,
        body: { ok: true, already_paid: true, order_gid: binding.orderGid },
      };
    }

    if (!binding.orderGid) {
      if (event.type === "checkout.paid" || event.type === "checkout.accepted") {
        binding.paid = true;
        binding.status = "paid";
        if (typeof data.booking_tx === "string") {
          binding.bookingTx = data.booking_tx;
        }
        binding.summary = `Payment of ${binding.expectedTotalUsd} USD booked via Openrail`;
        logger(
          `[shopify] invoice ${binding.checkoutId} for checkout_token ${binding.checkoutToken ?? "unknown"} was paid, but no matching Shopify order has arrived yet`,
        );
        processedEventIds.add(event.id);
        return {
          status: 200,
          body: {
            ok: true,
            status: "paid",
            pending_order: true,
            checkout_id: binding.checkoutId,
          },
        };
      }
      processedEventIds.add(event.id);
      return { status: 200, body: { ok: true, pending_order: true } };
    }

    let order: ShopifyOrder | null = null;
    try {
      order = await adminClient.getOrder(binding.orderGid);
    } catch (err) {
      if (isProtectedCustomerDataError(err)) {
        logger(
          `[shopify] cannot read order ${binding.numericId ?? extractNumericOrderId(binding.orderGid)}: the app is not approved for protected customer data; request access in the Dev Dashboard`,
        );
      } else {
        throw err;
      }
    }

    // Handle flagged checkouts (needs_attention)
    if (data.flagged === true || data.status === "needs_attention") {
      try {
        await adminClient.addOrderTags(binding.orderGid, ["openrail-needs-attention"]);
        if (order) {
          await appendOrderNote(
            adminClient,
            order,
            `Openrail: payment flagged for accounting review (checkout ${binding.checkoutId}). See the Openrail dashboard.`,
          );
        }
      } catch (err) {
        if (!isProtectedCustomerDataError(err)) throw err;
      }
      processedEventIds.add(event.id);
      return {
        status: 200,
        body: { ok: true, status: "needs_attention", order_gid: binding.orderGid },
      };
    }

    if (event.type === "checkout.created") {
      processedEventIds.add(event.id);
      return { status: 200, body: { ok: true, ignored: true } };
    }

    if (event.type === "checkout.partial") {
      // NEVER call orderMarkAsPaid on partial payment (shopify_partial_tagged_not_paid)
      const receivedUsd = formatBaseUnitsUsd(data.received);
      const remainingUsd = formatBaseUnitsUsd(data.remaining);
      try {
        await adminClient.addOrderTags(binding.orderGid, ["openrail-partial"]);
        if (order) {
          await appendOrderNote(
            adminClient,
            order,
            `Openrail: partial payment received (${receivedUsd} USD), ${remainingUsd} USD still due (checkout ${binding.checkoutId}).`,
          );
        }
      } catch (err) {
        if (!isProtectedCustomerDataError(err)) throw err;
      }
      processedEventIds.add(event.id);
      return {
        status: 200,
        body: { ok: true, status: "partial", order_gid: binding.orderGid },
      };
    }

    if (event.type === "checkout.paid_late") {
      // NEVER call orderMarkAsPaid or paymentSessionResolve on late payment
      const lateAmountUsd =
        typeof data.amount_usd === "string"
          ? data.amount_usd
          : formatBaseUnitsUsd(data.held_amount);
      try {
        await adminClient.addOrderTags(binding.orderGid, ["openrail-late"]);
        if (order) {
          await appendOrderNote(
            adminClient,
            order,
            `Openrail: paid after the checkout expired (${lateAmountUsd} USD) for checkout ${binding.checkoutId}. The money is booked; accept the order or refund the payer from the Openrail dashboard.`,
          );
        }
      } catch (err) {
        if (!isProtectedCustomerDataError(err)) throw err;
      }
      processedEventIds.add(event.id);
      return {
        status: 200,
        body: { ok: true, status: "late", order_gid: binding.orderGid },
      };
    }

    if (event.type === "checkout.refund_started") {
      const refundAmountUsd =
        typeof data.amount_usd === "string" ? data.amount_usd : binding.expectedTotalUsd;
      const refundTo = typeof data.refund_to === "string" ? data.refund_to : "payer";
      try {
        await adminClient.addOrderTags(binding.orderGid, ["openrail-refund-started"]);
        if (order) {
          await appendOrderNote(
            adminClient,
            order,
            `Openrail: refund started (${refundAmountUsd} USD) to payer address ${refundTo} from Openrail dashboard.`,
          );
        }
      } catch (err) {
        if (!isProtectedCustomerDataError(err)) throw err;
      }
      processedEventIds.add(event.id);
      return {
        status: 200,
        body: { ok: true, status: "refund_started", order_gid: binding.orderGid },
      };
    }

    if (event.type === "checkout.paid" || event.type === "checkout.accepted") {
      // Verify full payment including any pass_to_customer fee line (shopify_mark_paid_only_on_full_payment)
      const requiredUsd =
        typeof data.total_usd === "string" ? data.total_usd : binding.expectedTotalUsd;
      const paidUsd =
        typeof data.amount_usd === "string" ? data.amount_usd : requiredUsd;

      if (toCents(paidUsd) < toCents(requiredUsd)) {
        return {
          status: 409,
          body: {
            error: {
              code: "insufficient_payment_amount",
              message: `Paid amount ${paidUsd} USD is less than required checkout total ${requiredUsd} USD`,
            },
          },
        };
      }

      // Defect 1: Compare actual order total from Admin API to paid amount when payment arrives for linked order
      const orderTotalUsd = order?.totalOutstandingSet?.shopMoney?.amount;
      if (orderTotalUsd && toCents(paidUsd) < toCents(orderTotalUsd)) {
        const remainingUsd = ((toCents(orderTotalUsd) - toCents(paidUsd)) / 100).toFixed(2);
        binding.status = "partial";
        binding.paidUsd = paidUsd;
        binding.remainingUsd = remainingUsd;
        try {
          await adminClient.addOrderTags(binding.orderGid, ["openrail-partial"]);
          if (order) {
            await appendOrderNote(
              adminClient,
              order,
              `Openrail: partial payment received (${paidUsd} USD), ${remainingUsd} USD still due (checkout ${binding.checkoutId}).`,
            );
          }
        } catch (err) {
          if (!isProtectedCustomerDataError(err)) throw err;
        }
        logger(
          `[shopify] payment for order ${binding.orderGid} linked to checkout ${binding.checkoutId} was underpaid (paid ${paidUsd} USD, order total ${orderTotalUsd} USD)`,
        );
        processedEventIds.add(event.id);
        return {
          status: 200,
          body: { ok: true, status: "partial", order_gid: binding.orderGid },
        };
      }

      const numericId = binding.numericId ?? extractNumericOrderId(binding.orderGid);
      try {
        if (!order || (!order.fullyPaid && order.displayFinancialStatus !== "PAID")) {
          await adminClient.markOrderAsPaid(binding.orderGid);
        }
        settledOrderGids.add(binding.orderGid);
      } catch (err) {
        if (isProtectedCustomerDataError(err)) {
          logger(
            `[shopify] cannot mark order ${numericId} paid: the app is not approved for protected customer data; request access in the Dev Dashboard`,
          );
        } else {
          throw err;
        }
      }

      const bookingTx =
        typeof data.booking_tx === "string" ? data.booking_tx : undefined;
      if (binding.paymentSessionGid && paymentsAppClient) {
        await paymentsAppClient.paymentSessionResolve(
          binding.paymentSessionGid,
          bookingTx,
        );
      }

      binding.paid = true;
      binding.status = "paid";
      binding.paidUsd = paidUsd;
      binding.remainingUsd = "0.00";
      if (bookingTx) binding.bookingTx = bookingTx;
      binding.summary = `Payment of ${paidUsd} USD booked via Openrail`;

      try {
        const tag = event.type === "checkout.accepted" ? "openrail-accepted" : "openrail-paid";
        await adminClient.addOrderTags(binding.orderGid, [tag]);
        if (order) {
          const txDetail = bookingTx ? `, booking tx ${bookingTx}` : "";
          await appendOrderNote(
            adminClient,
            order,
            `Openrail: payment booked in full (${paidUsd} USD, checkout ${binding.checkoutId}${txDetail}).`,
          );
        }
      } catch (err) {
        if (!isProtectedCustomerDataError(err)) throw err;
      }

      processedEventIds.add(event.id);
      return {
        status: 200,
        body: { ok: true, status: "paid", order_gid: binding.orderGid },
      };
    }

    processedEventIds.add(event.id);
    return { status: 200, body: { ok: true, ignored: true } };
  }

  return {
    async handle(req: HttpRequest): Promise<HttpResponse> {
      const { method, path } = req;

      if (method === "GET" && path === "/health") {
        return { status: 200, body: { ok: true } };
      }

      if (method === "GET" && (path === "/" || path === "")) {
        return {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          body: {
            html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Openrail Checkout</title>
</head>
<body>
  <h1>Openrail Checkout</h1>
  <p>Openrail Checkout is installed on this store. Next: configure the Openrail manual payment method and add the Thank You block in the checkout editor (README step 8).</p>
</body>
</html>`,
          },
        };
      }

      if (method === "POST" && path === "/shopify/install/check") {
        return handleInstallCheck();
      }

      if (
        method === "POST" &&
        (path === "/shopify/webhooks" || path === "/shopify/webhooks/orders-create")
      ) {
        return handleOrdersCreateWebhook(req);
      }

      // The checkout block (a Shopify checkout UI extension) asks for the pay link with the buyer's session token.
      if (path === "/shopify/extension/pay-link") {
        const cors = {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "600",
        };
        if (method === "OPTIONS") return { status: 204, headers: cors, body: {} };
        if (method === "GET") {
          const shopKey = env.SHOPIFY_SHOP_DOMAIN;
          if (!checkRateLimit(shopKey, clock())) {
            return {
              status: 429,
              headers: cors,
              body: {
                error: {
                  code: "rate_limited",
                  message: "Too many requests for this shop",
                },
              },
            };
          }

          const auth = getHeader(req.headers, "authorization") ?? "";
          const token = /^Bearer (.+)$/i.exec(auth)?.[1];
          const checked =
            token === undefined
              ? { ok: false as const, reason: "missing" }
              : verifyShopifySessionToken(
                  token,
                  env.SHOPIFY_CLIENT_SECRET ?? "",
                  env.SHOPIFY_CLIENT_ID ?? "",
                  env.SHOPIFY_SHOP_DOMAIN,
                  clock(),
                );
          if (!checked.ok) {
            logSessionTokenRefusal(checked.reason, clock(), "detail" in checked ? checked.detail : undefined);
            return {
              status: 401,
              headers: cors,
              body: { error: { code: "invalid_session_token", message: checked.reason } },
            };
          }

          const parsedOrder = parseAndNormalizeOrderId(req.query.order);
          if (!parsedOrder) {
            return {
              status: 400,
              headers: cors,
              body: { error: { code: "invalid_request", message: "order must be an order id" } },
            };
          }
          const { numericId, orderGid } = parsedOrder;

          const nonOpenrail =
            nonOpenrailOrders.get(orderGid) ?? nonOpenrailOrders.get(numericId);
          if (nonOpenrail) {
            return {
              status: 404,
              headers: cors,
              body: {
                error: {
                  code: "not_openrail_order",
                  message: "Order does not use Openrail payment method",
                },
              },
            };
          }

          const orderRef = sanitizeOrderRef(`shopify-${numericId}`);
          let binding =
            bindingsByOrderGid.get(orderGid) ??
            bindingsByOrderGid.get(numericId) ??
            bindingsByOrderRef.get(orderRef);

          if (!binding && checkoutApi.getCheckoutByOrderRef) {
            const recovered = await checkoutApi.getCheckoutByOrderRef(orderRef);
            if (recovered) {
              const isPaid = recovered.status === "paid";
              const isPartial = recovered.status === "partial";
              const expectedTotal = recovered.total_usd ?? recovered.amount_usd;
              const paidUsd = isPaid
                ? expectedTotal
                : isPartial
                ? recovered.paid_usd ?? "0.00"
                : "0.00";
              const remainingUsd = isPaid
                ? "0.00"
                : isPartial
                ? recovered.remaining_usd ?? ((toCents(expectedTotal) - toCents(paidUsd)) / 100).toFixed(2)
                : expectedTotal;

              binding = {
                orderGid,
                numericId,
                orderName: orderRef,
                orderRef: recovered.order_ref,
                checkoutId: recovered.id,
                expectedTotalUsd: expectedTotal,
                payUrl: recovered.pay_url,
                paid: isPaid,
                paidUsd,
                remainingUsd,
                status: recovered.status,
                bookingTx: recovered.booking_tx,
              };
              bindingsByOrderRef.set(recovered.order_ref, binding);
              bindingsByCheckoutId.set(recovered.id, binding);
              bindingsByOrderGid.set(orderGid, binding);
              bindingsByOrderGid.set(numericId, binding);
            }
          }

          let order: ShopifyOrder | null = null;
          if (!binding) {
            try {
              order = await adminClient.getOrder(orderGid);
            } catch (error) {
              console.warn(
                `[shopify] pay-link: could not read order ${numericId} from the Admin API: ${error instanceof Error ? error.message : "unknown error"}`,
              );
              order = null;
            }
          }

          if (!binding && !order) {
            const reqKey = numericId ?? orderGid;
            const now = clock();
            const firstSeen = firstSeenOrderRequests.get(reqKey);
            if (firstSeen === undefined) {
              firstSeenOrderRequests.set(reqKey, now);
              if (numericId) firstSeenOrderRequests.set(numericId, now);
              if (orderGid) firstSeenOrderRequests.set(orderGid, now);
            }
            const elapsed = now - (firstSeen ?? now);
            if (elapsed <= 120) {
              return {
                status: 202,
                headers: cors,
                body: {
                  status: "order_pending",
                  paid: false,
                  summary: "Preparing your payment link…",
                },
              };
            }
            return {
              status: 404,
              headers: cors,
              body: { error: { code: "order_not_found", message: "Order not found" } },
            };
          }

          if (order) {
            const gateways = (order.paymentGatewayNames ?? []).filter(Boolean);
            const usesOpenrail =
              gateways.length > 0 && gateways.some((g) => /openrail|stablecoin/i.test(g));
            if (!usesOpenrail) {
              console.warn(
                `[shopify] pay-link: order ${numericId} is not an Openrail order (gateway names: ${gateways.length > 0 ? gateways.join(" | ") : "none"})`,
              );
              return {
                status: 404,
                headers: cors,
                body: {
                  error: {
                    code: "not_openrail_order",
                    message: "Order does not use Openrail payment method",
                  },
                },
              };
            }

            const shopMoney = order.totalOutstandingSet?.shopMoney;
            const orderTotalAmount = Number(
              order.currentTotalPriceSet?.shopMoney?.amount ??
              order.totalOutstandingSet?.shopMoney?.amount ??
              "0",
            );
            if (!Number.isFinite(orderTotalAmount) || orderTotalAmount <= 0) {
              return {
                status: 404,
                headers: cors,
                body: {
                  error: {
                    code: "not_openrail_order",
                    message: "Order total must be greater than zero",
                  },
                },
              };
            }

            if (order.currencyCode !== "USD" || shopMoney?.currencyCode !== "USD") {
              return {
                status: 422,
                headers: cors,
                body: {
                  error: {
                    code: "unsupported_currency",
                    message: `Order currency must be USD (received ${shopMoney?.currencyCode ?? order.currencyCode}).`,
                  },
                },
              };
            }
          }

          const confirmation = req.query.confirmation;
          let confirmationMatches =
            (binding ? matchesBindingConfirmation(binding, confirmation) : false) ||
            (order ? matchesOrderConfirmation(order, confirmation) : false);

          if (!confirmationMatches && orderGid) {
            if (!order) {
              try {
                order = await adminClient.getOrder(orderGid);
              } catch {
                order = null;
              }
            }
            if (order && matchesOrderConfirmation(order, confirmation)) {
              confirmationMatches = true;
              if (binding) {
                binding.confirmationNumber = order.confirmationNumber ?? confirmation;
              }
            }
          }

          if (!confirmationMatches) {
            return {
              status: 403,
              headers: cors,
              body: {
                error: {
                  code: "order_access_denied",
                  message: "Order confirmation mismatch or missing",
                },
              },
            };
          }

          if (!binding) {
            const shopMoney = order!.totalOutstandingSet?.shopMoney;
            const orderTotalAmount = Number(
              order!.currentTotalPriceSet?.shopMoney?.amount ??
              order!.totalOutstandingSet?.shopMoney?.amount ??
              "0",
            );
            const amountUsd = Number(shopMoney?.amount ?? orderTotalAmount).toFixed(2);
            const idempotencyKey = `shopify-order-${numericId}-${amountUsd}`;
            const items = (order!.lineItems ?? []).map((item) => ({
              name: item.title,
              quantity: item.quantity,
              ...(item.unitPriceUsd ? { unit_price_usd: item.unitPriceUsd } : {}),
            }));

            const { checkout } = await checkoutApi.createCheckout(
              {
                order_ref: orderRef,
                amount_usd: amountUsd,
                currency: "USD",
                expires_in_minutes: 60,
                return_url: order!.statusPageUrl,
                cancel_url: order!.statusPageUrl,
                ...(items.length > 0 ? { items } : {}),
              },
              idempotencyKey,
            );

            const newBinding: OrderBinding = {
              orderGid,
              numericId,
              orderName: order!.name,
              orderRef,
              checkoutId: checkout.id,
              expectedTotalUsd: checkout.total_usd ?? checkout.amount_usd,
              payUrl: checkout.pay_url,
              paid: order!.fullyPaid || order!.displayFinancialStatus === "PAID",
              status: order!.fullyPaid || order!.displayFinancialStatus === "PAID" ? "paid" : "unpaid",
              gateways: order!.paymentGatewayNames ?? [],
              currency: "USD",
              confirmationNumber: order!.confirmationNumber ?? undefined,
            };
            binding = newBinding;
            bindingsByOrderRef.set(orderRef, newBinding);
            bindingsByCheckoutId.set(checkout.id, newBinding);
            bindingsByOrderGid.set(orderGid, newBinding);
            bindingsByOrderGid.set(numericId, newBinding);
          } else if (!binding.checkoutId || !binding.payUrl) {
            const amountUsd = Number(binding.expectedTotalUsd).toFixed(2);
            const idempotencyKey = `shopify-order-${numericId}-${amountUsd}`;
            const { checkout } = await checkoutApi.createCheckout(
              {
                order_ref: orderRef,
                amount_usd: amountUsd,
                currency: "USD",
                expires_in_minutes: 60,
              },
              idempotencyKey,
            );
            binding.checkoutId = checkout.id;
            binding.payUrl = checkout.pay_url;
            bindingsByCheckoutId.set(checkout.id, binding);
          }

          if (!binding) {
            return {
              status: 404,
              headers: cors,
              body: { error: { code: "order_not_found", message: "Order not found" } },
            };
          }

          const orderToken = createOrderPayToken(
            {
              orderGid,
              orderName: binding.orderName,
              shopDomain: env.SHOPIFY_SHOP_DOMAIN,
              nonce: randomUUID(),
              exp: clock() + 3600,
            },
            env.SHOPIFY_ORDER_TOKEN_SECRET,
          );
          const base = env.APP_BASE_URL.replace(/\/+$/, "");
          return {
            status: 200,
            headers: cors,
            body: {
              ok: true,
              pay_url: `${base}/shopify/pay/${encodeURIComponent(orderToken)}`,
              checkout_pay_url: binding.payUrl ?? `${base}/shopify/pay/${encodeURIComponent(orderToken)}`,
              checkout_id: binding.checkoutId,
            },
          };
        }
      }

      // The pre-order checkout block asks for the pay link with the buyer's session token and cart info.
      // Gated behind SHOPIFY_PRE_ORDER_LINK=1 (off by default; returns 404 when off).
      if (path === "/shopify/extension/checkout-pay-link") {
        const cors = {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "600",
        };
        if (method === "OPTIONS") return { status: 204, headers: cors, body: {} };
        if (env.SHOPIFY_PRE_ORDER_LINK !== "1") {
          return {
            status: 404,
            headers: cors,
            body: {
              error: {
                code: "not_found",
                message: "Pre-order checkout pay link is disabled",
              },
            },
          };
        }
        if (method === "GET") {
          const auth = getHeader(req.headers, "authorization") ?? "";
          const token = /^Bearer (.+)$/i.exec(auth)?.[1];
          const checked =
            token === undefined
              ? { ok: false as const, reason: "missing" }
              : verifyShopifySessionToken(
                  token,
                  env.SHOPIFY_CLIENT_SECRET ?? "",
                  env.SHOPIFY_CLIENT_ID ?? "",
                  env.SHOPIFY_SHOP_DOMAIN,
                  clock(),
                );
          if (!checked.ok) {
            logSessionTokenRefusal(checked.reason, clock(), "detail" in checked ? checked.detail : undefined);
            return {
              status: 401,
              headers: cors,
              body: { error: { code: "invalid_session_token", message: checked.reason } },
            };
          }

          // Defect 2: Rate limit route per shop
          const shopKey = env.SHOPIFY_SHOP_DOMAIN;
          const now = clock();
          const timestamps = checkoutRequestsByShop.get(shopKey) ?? [];
          const recent = timestamps.filter((t) => t > now - RATE_LIMIT_WINDOW_SEC);
          if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
            return {
              status: 429,
              headers: cors,
              body: {
                error: {
                  code: "rate_limited",
                  message: "Too many checkout requests for this shop",
                },
              },
            };
          }
          recent.push(now);
          checkoutRequestsByShop.set(shopKey, recent);

          const checkoutToken = (req.query.checkout ?? "").trim();
          if (!checkoutToken) {
            return {
              status: 400,
              headers: cors,
              body: {
                error: {
                  code: "invalid_request",
                  message: "checkout query parameter is required",
                },
              },
            };
          }

          // Defect 1: Refuse missing, non-numeric, or <= 0 amount with 400
          const rawAmount = req.query.amount ? String(req.query.amount).trim() : "";
          if (!rawAmount || !/^\d+(\.\d+)?$/.test(rawAmount)) {
            return {
              status: 400,
              headers: cors,
              body: {
                error: {
                  code: "invalid_request",
                  message: "amount is required and must be a positive number",
                },
              },
            };
          }
          const parsed = Number(rawAmount);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            return {
              status: 400,
              headers: cors,
              body: {
                error: {
                  code: "invalid_request",
                  message: "amount must be greater than zero",
                },
              },
            };
          }
          const amountUsd = parsed.toFixed(2);

          // Idempotency: the same checkout with identical amount returns the same link.
          // When cart total changes, create a new invoice instead of returning stale link.
          const existing = bindingsByCheckoutToken.get(checkoutToken);
          if (existing?.payUrl && existing.expectedTotalUsd === amountUsd) {
            return {
              status: 200,
              headers: cors,
              body: { pay_url: existing.payUrl },
            };
          }

          const currency = (req.query.currency ?? "USD").trim().toUpperCase();
          if (currency !== "USD") {
            return {
              status: 422,
              headers: cors,
              body: {
                error: {
                  code: "unsupported_currency",
                  message: `Openrail requires USD currency (received ${currency}).`,
                },
              },
            };
          }

          const amountTag = amountUsd.replace(".", "_");
          const orderRef = sanitizeOrderRef(`shopify-chk-${checkoutToken}-${amountTag}`);
          const idempotencyKey = `shopify-chk-${checkoutToken}-${amountTag}`;

          const { checkout } = await checkoutApi.createCheckout(
            {
              order_ref: orderRef,
              amount_usd: amountUsd,
              currency: "USD",
              expires_in_minutes: 60,
            },
            idempotencyKey,
          );

          const binding: OrderBinding = {
            orderGid: "",
            orderName: orderRef,
            orderRef,
            checkoutId: checkout.id,
            expectedTotalUsd: checkout.total_usd ?? checkout.amount_usd,
            checkoutToken,
            payUrl: checkout.pay_url,
            paid: false,
            status: "pending",
          };
          bindingsByOrderRef.set(orderRef, binding);
          bindingsByCheckoutId.set(checkout.id, binding);
          bindingsByCheckoutToken.set(checkoutToken, binding);

          return {
            status: 200,
            headers: cors,
            body: { pay_url: checkout.pay_url },
          };
        }
      }

      // The thank-you / order status block queries the order's Openrail state.
      if (path === "/shopify/extension/order-status") {
        const cors = {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "600",
        };
        if (method === "OPTIONS") return { status: 204, headers: cors, body: {} };
        if (method === "GET") {
          const shopKey = env.SHOPIFY_SHOP_DOMAIN;
          if (!checkRateLimit(shopKey, clock())) {
            return {
              status: 429,
              headers: cors,
              body: {
                error: {
                  code: "rate_limited",
                  message: "Too many requests for this shop",
                },
              },
            };
          }

          const auth = getHeader(req.headers, "authorization") ?? "";
          const token = /^Bearer (.+)$/i.exec(auth)?.[1];
          const checked =
            token === undefined
              ? { ok: false as const, reason: "missing" }
              : verifyShopifySessionToken(
                  token,
                  env.SHOPIFY_CLIENT_SECRET ?? "",
                  env.SHOPIFY_CLIENT_ID ?? "",
                  env.SHOPIFY_SHOP_DOMAIN,
                  clock(),
                );
          if (!checked.ok) {
            logSessionTokenRefusal(checked.reason, clock(), "detail" in checked ? checked.detail : undefined);
            return {
              status: 401,
              headers: cors,
              body: { error: { code: "invalid_session_token", message: checked.reason } },
            };
          }

          const rawOrder = (req.query.order ?? "").trim();
          const checkoutQuery = (req.query.checkout ?? "").trim();
          if (!rawOrder && !checkoutQuery) {
            return {
              status: 400,
              headers: cors,
              body: {
                error: {
                  code: "invalid_request",
                  message: "order or checkout query parameter is required",
                },
              },
            };
          }

          let orderGid: string | undefined;
          let numericId: string | undefined;
          if (rawOrder) {
            const parsedOrder = parseAndNormalizeOrderId(rawOrder);
            if (!parsedOrder) {
              return {
                status: 400,
                headers: cors,
                body: {
                  error: {
                    code: "invalid_request",
                    message: "order must be a valid order id",
                  },
                },
              };
            }
            orderGid = parsedOrder.orderGid;
            numericId = parsedOrder.numericId;
          }

          if (orderGid || numericId) {
            const nonOpenrail =
              (orderGid ? nonOpenrailOrders.get(orderGid) : undefined) ??
              (numericId ? nonOpenrailOrders.get(numericId) : undefined);
            if (nonOpenrail) {
              return {
                status: 404,
                headers: cors,
                body: {
                  error: {
                    code: "not_openrail_order",
                    message: "Order does not use Openrail payment method",
                  },
                },
              };
            }
          }

          let binding: OrderBinding | undefined;
          if (checkoutQuery) {
            binding = bindingsByCheckoutToken.get(checkoutQuery);
          }
          if (!binding && orderGid && numericId) {
            binding = bindingsByOrderGid.get(orderGid) ?? bindingsByOrderGid.get(numericId);
            if (!binding) {
              for (const b of bindingsByCheckoutId.values()) {
                if (
                  b.orderGid === orderGid ||
                  (b.orderGid && extractNumericOrderId(b.orderGid) === numericId)
                ) {
                  binding = b;
                  break;
                }
              }
            }
            if (!binding && checkoutApi.getCheckoutByOrderRef) {
              const orderRef = sanitizeOrderRef(`shopify-${numericId}`);
              const recovered = await checkoutApi.getCheckoutByOrderRef(orderRef);
              if (recovered) {
                const isPaid = recovered.status === "paid";
                const isPartial = recovered.status === "partial";
                const expectedTotal = recovered.total_usd ?? recovered.amount_usd;
                const paidUsd = isPaid
                  ? expectedTotal
                  : isPartial
                  ? recovered.paid_usd ?? "0.00"
                  : "0.00";
                const remainingUsd = isPaid
                  ? "0.00"
                  : isPartial
                  ? recovered.remaining_usd ?? ((toCents(expectedTotal) - toCents(paidUsd)) / 100).toFixed(2)
                  : expectedTotal;

                binding = {
                  orderGid,
                  numericId,
                  orderName: orderRef,
                  orderRef: recovered.order_ref,
                  checkoutId: recovered.id,
                  expectedTotalUsd: expectedTotal,
                  payUrl: recovered.pay_url,
                  paid: isPaid,
                  paidUsd,
                  remainingUsd,
                  status: recovered.status,
                  bookingTx: recovered.booking_tx,
                };
                bindingsByOrderRef.set(recovered.order_ref, binding);
                bindingsByCheckoutId.set(recovered.id, binding);
                bindingsByOrderGid.set(orderGid, binding);
                bindingsByOrderGid.set(numericId, binding);
              }
            }
          }

          if (binding && orderGid) {
            binding.orderGid = orderGid;
            bindingsByOrderGid.set(orderGid, binding);
            if (numericId) bindingsByOrderGid.set(numericId, binding);
          }

          let order: ShopifyOrder | null = null;
          if (!binding && orderGid) {
            try {
              order = await adminClient.getOrder(orderGid);
            } catch (error) {
              console.warn(
                `[shopify] order-status: could not read order ${numericId || orderGid} from the Admin API: ${error instanceof Error ? error.message : "unknown error"}`,
              );
              order = null;
            }
          }

          if (!binding && !order) {
            if (orderGid && numericId) {
              const reqKey = numericId;
              const now = clock();
              const firstSeen = firstSeenOrderRequests.get(reqKey);
              if (firstSeen === undefined) {
                firstSeenOrderRequests.set(reqKey, now);
                firstSeenOrderRequests.set(orderGid, now);
              }
              const elapsed = now - (firstSeen ?? now);
              if (elapsed <= 120) {
                return {
                  status: 202,
                  headers: cors,
                  body: {
                    status: "order_pending",
                    paid: false,
                    summary: "Preparing your payment link…",
                  },
                };
              }
            }
            return {
              status: 404,
              headers: cors,
              body: {
                error: {
                  code: "order_not_found",
                  message: "No Openrail payment record found for this order",
                },
              },
            };
          }

          if (order) {
            const gateways = (order.paymentGatewayNames ?? []).filter(Boolean);
            const usesOpenrail =
              gateways.length > 0 && gateways.some((g) => /openrail|stablecoin/i.test(g));
            if (!usesOpenrail) {
              console.warn(
                `[shopify] order-status: order ${numericId || order.id} is not an Openrail order (gateway names: ${gateways.length > 0 ? gateways.join(" | ") : "none"})`,
              );
              return {
                status: 404,
                headers: cors,
                body: {
                  error: {
                    code: "not_openrail_order",
                    message: "Order does not use Openrail payment method",
                  },
                },
              };
            }

            const shopMoney = order.totalOutstandingSet?.shopMoney;
            const orderTotalAmount = Number(
              order.currentTotalPriceSet?.shopMoney?.amount ??
              order.totalOutstandingSet?.shopMoney?.amount ??
              "0",
            );
            if (!Number.isFinite(orderTotalAmount) || orderTotalAmount <= 0) {
              return {
                status: 404,
                headers: cors,
                body: {
                  error: {
                    code: "not_openrail_order",
                    message: "Order total must be greater than zero",
                  },
                },
              };
            }

            if (order.currencyCode !== "USD" || shopMoney?.currencyCode !== "USD") {
              return {
                status: 422,
                headers: cors,
                body: {
                  error: {
                    code: "unsupported_currency",
                    message: `Order currency must be USD (received ${shopMoney?.currencyCode ?? order.currencyCode}).`,
                  },
                },
              };
            }

            if (!binding) {
              const numId = extractNumericOrderId(order.id);
              const orderRef = sanitizeOrderRef(`shopify-${numId}`);
              const totalUsd = orderTotalAmount.toFixed(2);
              const isPaid = order.fullyPaid || order.displayFinancialStatus === "PAID";
              const newBinding: OrderBinding = {
                orderGid: order.id,
                numericId: numId,
                orderName: order.name,
                orderRef,
                checkoutId: "",
                expectedTotalUsd: totalUsd,
                paid: isPaid,
                paidUsd: isPaid ? totalUsd : "0.00",
                remainingUsd: isPaid ? "0.00" : totalUsd,
                status: isPaid ? "paid" : "unpaid",
                gateways: order.paymentGatewayNames ?? [],
                currency: "USD",
                confirmationNumber: order.confirmationNumber ?? undefined,
              };
              binding = newBinding;
              bindingsByOrderRef.set(orderRef, newBinding);
              bindingsByOrderGid.set(order.id, newBinding);
              bindingsByOrderGid.set(numId, newBinding);
            }
          }

          if (!binding) {
            return {
              status: 404,
              headers: cors,
              body: {
                error: {
                  code: "order_not_found",
                  message: "No Openrail payment record found for this order",
                },
              },
            };
          }

          const confirmationParam = req.query.confirmation;
          let confirmationMatches =
            (binding ? matchesBindingConfirmation(binding, confirmationParam) : false) ||
            (order ? matchesOrderConfirmation(order, confirmationParam) : false);

          if (!confirmationMatches && orderGid) {
            if (!order) {
              try {
                order = await adminClient.getOrder(orderGid);
              } catch {
                order = null;
              }
            }
            if (order && matchesOrderConfirmation(order, confirmationParam)) {
              confirmationMatches = true;
              if (binding) {
                binding.confirmationNumber = order.confirmationNumber ?? confirmationParam;
              }
            }
          }

          const totalUsd = binding.expectedTotalUsd;
          let status: "unpaid" | "partial" | "paid" | "pending" = "unpaid";
          if (binding.paid || binding.status === "paid") {
            status = "paid";
          } else if (binding.status === "partial") {
            status = "partial";
          } else if (checkoutQuery && !orderGid) {
            status = (binding.status as "pending") ?? "pending";
          } else {
            status = "unpaid";
          }

          // Prompt 1c: If confirmation number was not matched, minimise what the route returns
          // (status only, no amounts, no hash, no pay link)
          if (orderGid && !confirmationMatches) {
            const minSummary =
              status === "paid"
                ? "Payment confirmed on NEAR"
                : status === "partial"
                ? "Partial payment received"
                : "Payment pending";
            return {
              status: 200,
              headers: cors,
              body: {
                status,
                paid: status === "paid",
                summary: binding.summary ?? minSummary,
              },
            };
          }

          const paidUsd =
            status === "paid"
              ? binding.paidUsd ?? totalUsd
              : status === "partial"
              ? binding.paidUsd ?? "0.00"
              : "0.00";

          const remainingUsd =
            status === "paid"
              ? "0.00"
              : status === "partial"
              ? binding.remainingUsd ?? ((toCents(totalUsd) - toCents(paidUsd)) / 100).toFixed(2)
              : totalUsd;

          let payUrl = binding.payUrl;
          if (!payUrl && binding.orderGid) {
            const orderToken = createOrderPayToken(
              {
                orderGid: binding.orderGid,
                orderName: binding.orderName,
                shopDomain: env.SHOPIFY_SHOP_DOMAIN,
                nonce: randomUUID(),
                exp: clock() + 3600,
              },
              env.SHOPIFY_ORDER_TOKEN_SECRET,
            );
            const base = env.APP_BASE_URL.replace(/\/+$/, "");
            payUrl = `${base}/shopify/pay/${encodeURIComponent(orderToken)}`;
          }

          const defaultSummary =
            status === "paid"
              ? `Payment of $${totalUsd} USD confirmed on NEAR`
              : status === "partial"
              ? `Partial payment of $${paidUsd} of $${totalUsd} USD received`
              : `Payment of $${totalUsd} USD pending`;

          return {
            status: 200,
            headers: cors,
            body: {
              status,
              paid: status === "paid",
              total_usd: totalUsd,
              paid_usd: paidUsd,
              remaining_usd: remainingUsd,
              pay_url: payUrl,
              tx_hash: binding.bookingTx ?? null,
              summary: binding.summary ?? defaultSummary,
              checkout_id: binding.checkoutId || undefined,
              order_gid: binding.orderGid || undefined,
              amount_usd: totalUsd,
            },
          };
        }
      }

      const payMatch = /^\/shopify\/pay\/([^/]+)$/.exec(path);
      if (method === "GET" && payMatch?.[1]) {
        return handleOrderPayRedirect(payMatch[1], req);
      }

      if (method === "POST" && path === "/shopify/payment_session") {
        return handleOffsitePaymentSession(req);
      }

      if (
        method === "POST" &&
        (path === "/shopify/openrail-webhook" || path === "/shopify/webhooks/openrail")
      ) {
        return handleOpenrailWebhook(req);
      }

      return {
        status: 404,
        body: { error: { code: "not_found", message: `Route not found: ${method} ${path}` } },
      };
    },
  };
}
