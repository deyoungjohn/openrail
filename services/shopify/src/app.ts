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
    out[key] = val;
  }

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
}

export interface CheckoutApiPort {
  createCheckout(
    req: CreateCheckoutRequest,
    idempotencyKey: string,
  ): Promise<{ status: number; checkout: CheckoutCreatedResponse }>;
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
  orderName: string;
  orderRef: string;
  checkoutId: string;
  expectedTotalUsd: string;
  paymentSessionGid?: string;
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

function extractNumericOrderId(orderGid: string): string {
  const match = /(\d+)$/.exec(orderGid);
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

export interface CreateShopifyAppOptions {
  env: ShopifyAppEnv;
  adminClient: ShopifyAdminClient;
  paymentsAppClient?: ShopifyPaymentsAppClient;
  checkoutApi: CheckoutApiPort;
  tokenStore?: OrderTokenStore;
  clock?: () => number;
}

export function createShopifyApp(options: CreateShopifyAppOptions) {
  const { env, adminClient, paymentsAppClient, checkoutApi } = options;
  const tokenStore = options.tokenStore ?? new OrderTokenStore();
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1000));

  // Fetch-once bindings & deduplication stores
  const bindingsByOrderRef = new Map<string, OrderBinding>();
  const bindingsByCheckoutId = new Map<string, OrderBinding>();
  const processedEventIds = new Set<string>();
  const settledOrderGids = new Set<string>();

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

    const gateways = Array.isArray(payload.payment_gateway_names)
      ? (payload.payment_gateway_names as unknown[]).map(String)
      : [];
    const usesOpenrail = gateways.some((g) => /openrail|stablecoin/i.test(g));
    if (!usesOpenrail) {
      return { status: 200, body: { ignored: true, reason: "non_openrail_gateway" } };
    }

    const orderGid =
      typeof payload.admin_graphql_api_id === "string"
        ? payload.admin_graphql_api_id
        : `gid://shopify/Order/${String(payload.id ?? "")}`;
    const orderName = typeof payload.name === "string" ? payload.name : orderGid;
    const shopDomain =
      getHeader(req.headers, "x-shopify-shop-domain") ?? env.SHOPIFY_SHOP_DOMAIN;

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

    // Rule: ALWAYS read the outstanding total from the Shopify Admin GraphQL API, NEVER from the browser
    const order = await adminClient.getOrder(verified.payload.orderGid);
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
      settledOrderGids.has(binding.orderGid) &&
      (event.type === "checkout.paid" || event.type === "checkout.accepted")
    ) {
      processedEventIds.add(event.id);
      return {
        status: 200,
        body: { ok: true, already_paid: true, order_gid: binding.orderGid },
      };
    }

    const order = await adminClient.getOrder(binding.orderGid);

    // Handle flagged checkouts (needs_attention)
    if (data.flagged === true || data.status === "needs_attention") {
      await adminClient.addOrderTags(order.id, ["openrail-needs-attention"]);
      await appendOrderNote(
        adminClient,
        order,
        `Openrail: payment flagged for accounting review (checkout ${binding.checkoutId}). See the Openrail dashboard.`,
      );
      processedEventIds.add(event.id);
      return {
        status: 200,
        body: { ok: true, status: "needs_attention", order_gid: order.id },
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
      await adminClient.addOrderTags(order.id, ["openrail-partial"]);
      await appendOrderNote(
        adminClient,
        order,
        `Openrail: partial payment received (${receivedUsd} USD), ${remainingUsd} USD still due (checkout ${binding.checkoutId}).`,
      );
      processedEventIds.add(event.id);
      return {
        status: 200,
        body: { ok: true, status: "partial", order_gid: order.id },
      };
    }

    if (event.type === "checkout.paid_late") {
      // NEVER call orderMarkAsPaid or paymentSessionResolve on late payment
      const lateAmountUsd =
        typeof data.amount_usd === "string"
          ? data.amount_usd
          : formatBaseUnitsUsd(data.held_amount);
      await adminClient.addOrderTags(order.id, ["openrail-late"]);
      await appendOrderNote(
        adminClient,
        order,
        `Openrail: paid after the checkout expired (${lateAmountUsd} USD) for checkout ${binding.checkoutId}. The money is booked; accept the order or refund the payer from the Openrail dashboard.`,
      );
      processedEventIds.add(event.id);
      return {
        status: 200,
        body: { ok: true, status: "late", order_gid: order.id },
      };
    }

    if (event.type === "checkout.refund_started") {
      const refundAmountUsd =
        typeof data.amount_usd === "string" ? data.amount_usd : binding.expectedTotalUsd;
      const refundTo = typeof data.refund_to === "string" ? data.refund_to : "payer";
      await adminClient.addOrderTags(order.id, ["openrail-refund-started"]);
      await appendOrderNote(
        adminClient,
        order,
        `Openrail: refund started (${refundAmountUsd} USD) to payer address ${refundTo} from Openrail dashboard.`,
      );
      processedEventIds.add(event.id);
      return {
        status: 200,
        body: { ok: true, status: "refund_started", order_gid: order.id },
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

      if (!order.fullyPaid && order.displayFinancialStatus !== "PAID") {
        await adminClient.markOrderAsPaid(order.id);
      }
      settledOrderGids.add(order.id);

      const bookingTx =
        typeof data.booking_tx === "string" ? data.booking_tx : undefined;
      if (binding.paymentSessionGid && paymentsAppClient) {
        await paymentsAppClient.paymentSessionResolve(
          binding.paymentSessionGid,
          bookingTx,
        );
      }

      const tag = event.type === "checkout.accepted" ? "openrail-accepted" : "openrail-paid";
      await adminClient.addOrderTags(order.id, [tag]);
      const txDetail = bookingTx ? `, booking tx ${bookingTx}` : "";
      await appendOrderNote(
        adminClient,
        order,
        `Openrail: payment booked in full (${paidUsd} USD, checkout ${binding.checkoutId}${txDetail}).`,
      );

      processedEventIds.add(event.id);
      return {
        status: 200,
        body: { ok: true, status: "paid", order_gid: order.id },
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
          if (!checked.ok)
            return {
              status: 401,
              headers: cors,
              body: { error: { code: "invalid_session_token", message: checked.reason } },
            };
          const orderGid = (req.query.order ?? "").trim();
          if (!/^gid:\/\/shopify\/Order\/\d+$/.test(orderGid))
            return {
              status: 400,
              headers: cors,
              body: { error: { code: "invalid_request", message: "order must be an order id" } },
            };
          const orderToken = createOrderPayToken(
            {
              orderGid,
              orderName: orderGid,
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
            body: { pay_url: `${base}/shopify/pay/${encodeURIComponent(orderToken)}` },
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
