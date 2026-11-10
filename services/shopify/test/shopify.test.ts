import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ShopifyAdminClient,
  type ShopifyOrder,
  type ShopifyShop,
} from "../src/admin-client.js";
import {
  createShopifyApp,
  loadShopifyAppEnv,
  type CheckoutApiPort,
  type ShopifyAppEnv,
} from "../src/app.js";
import { buildThankYouBlockModel } from "../extensions/openrail-thank-you-block/src/ThankYouBlock.js";
import {
  OrderTokenStore,
  createOrderPayToken,
  signOpenrailWebhook,
  signShopifyWebhookHmac,
  verifyOpenrailWebhookSignature,
  verifyOrderPayToken,
  verifyShopifyWebhookHmac,
} from "../src/hmac.js";
import { ShopifyPaymentsAppClient } from "../src/payments-app-client.js";
import { createShopifyHttpListener } from "../src/server.js";

const TEST_ENV: ShopifyAppEnv = {
  SHOPIFY_SHOP_DOMAIN: "openrail-dev.myshopify.com",
  SHOPIFY_CLIENT_ID: "client_id_test_123456",
  SHOPIFY_CLIENT_SECRET: "shpss_test_client_secret_abcdef",
  SHOPIFY_WEBHOOK_SECRET: "shpss_test_webhook_secret_123456",
  SHOPIFY_ORDER_TOKEN_SECRET: "ordtok_test_secret_abcdef0123456789",
  OPENRAIL_API_URL: "https://api.openrail.incepture.dev",
  OPENRAIL_API_KEY: "or_sk_live_test_0000000000000000",
  OPENRAIL_WEBHOOK_SECRET: "whsec_test_openrail_secret_987654",
  APP_BASE_URL: "https://shopify.openrail.incepture.dev",
};

function makeUsdShop(overrides: Partial<ShopifyShop> = {}): ShopifyShop {
  return {
    name: "Openrail Dev Store",
    currencyCode: "USD",
    myshopifyDomain: "openrail-dev.myshopify.com",
    primaryDomain: {
      url: "https://openrail-dev.myshopify.com",
      host: "openrail-dev.myshopify.com",
    },
    ...overrides,
  };
}

function makeOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: "gid://shopify/Order/6001002003",
    name: "#1001",
    currencyCode: "USD",
    presentmentCurrencyCode: "USD",
    displayFinancialStatus: "PENDING",
    fullyPaid: false,
    canMarkAsPaid: true,
    note: null,
    tags: [],
    statusPageUrl: "https://openrail-dev.myshopify.com/6001002003/orders/abc123status",
    totalOutstandingSet: {
      shopMoney: {
        amount: "2.00",
        currencyCode: "USD",
      },
      presentmentMoney: {
        amount: "2.00",
        currencyCode: "USD",
      },
    },
    currentTotalPriceSet: {
      shopMoney: {
        amount: "2.00",
        currencyCode: "USD",
      },
    },
    paymentGatewayNames: ["Pay with stablecoins (Openrail)"],
    lineItems: [
      {
        title: "Test Coffee",
        quantity: 1,
        unitPriceUsd: "2.00",
      },
    ],
    ...overrides,
  };
}

function createTestHarness(options: {
  shop?: ShopifyShop;
  order?: ShopifyOrder;
  feeMode?: "absorb" | "pass_to_customer";
  nowSec?: number;
} = {}) {
  let currentNowSec = options.nowSec ?? 1_762_700_000;
  const shop = options.shop ?? makeUsdShop();
  const orders = new Map<string, ShopifyOrder>();
  const initialOrder = options.order ?? makeOrder();
  orders.set(initialOrder.id, structuredClone(initialOrder));

  const markPaidCalls: string[] = [];
  const tagsAddCalls: Array<{ id: string; tags: string[] }> = [];
  const orderNoteUpdates: Array<{ id: string; note: string }> = [];
  const resolvedSessions: Array<{ id: string; networkTransactionId?: string }> = [];
  const rejectedSessions: Array<{ id: string; code: string; merchantMessage?: string }> = [];
  const checkoutCreateCalls: Array<{
    body: Record<string, unknown>;
    idempotencyKey: string;
  }> = [];

  const checkoutsByOrderRef = new Map<
    string,
    {
      id: string;
      token_id: string;
      order_ref: string;
      amount_usd: string;
      subtotal_usd: string;
      fee_usd: string;
      total_usd: string;
      fee_mode: "absorb" | "pass_to_customer";
      amount_due: string;
      pay_url: string;
      return_url: string | null;
      cancel_url: string | null;
      expires_at: string;
      status: string;
    }
  >();

  const adminClient = {
    getShop: vi.fn(async () => structuredClone(shop)),
    getOrder: vi.fn(async (orderGid: string) => {
      const found = orders.get(orderGid);
      if (!found) throw new Error(`Order not found: ${orderGid}`);
      return structuredClone(found);
    }),
    markOrderAsPaid: vi.fn(async (orderGid: string) => {
      markPaidCalls.push(orderGid);
      const found = orders.get(orderGid);
      if (found) {
        found.fullyPaid = true;
        found.displayFinancialStatus = "PAID";
        found.canMarkAsPaid = false;
        found.totalOutstandingSet.shopMoney.amount = "0.00";
      }
      return {
        order: found ? structuredClone(found) : null,
        userErrors: [],
      };
    }),
    addOrderTags: vi.fn(async (orderGid: string, tags: string[]) => {
      tagsAddCalls.push({ id: orderGid, tags });
      const found = orders.get(orderGid);
      if (found) {
        for (const t of tags) {
          if (!found.tags.includes(t)) found.tags.push(t);
        }
      }
      return { userErrors: [] };
    }),
    updateOrderNote: vi.fn(async (orderGid: string, note: string) => {
      orderNoteUpdates.push({ id: orderGid, note });
      const found = orders.get(orderGid);
      if (found) {
        found.note = note;
      }
      return { userErrors: [] };
    }),
  };

  const paymentsAppClient = {
    paymentSessionResolve: vi.fn(async (id: string, networkTransactionId?: string) => {
      resolvedSessions.push({ id, ...(networkTransactionId ? { networkTransactionId } : {}) });
      return { redirectUrl: initialOrder.statusPageUrl, userErrors: [] };
    }),
    paymentSessionPending: vi.fn(async () => ({ userErrors: [] })),
    paymentSessionReject: vi.fn(
      async (id: string, code: string, merchantMessage?: string) => {
        rejectedSessions.push({ id, code, ...(merchantMessage ? { merchantMessage } : {}) });
        return { redirectUrl: initialOrder.statusPageUrl, userErrors: [] };
      },
    ),
    paymentsAppConfigure: vi.fn(async () => ({ Ready: true, userErrors: [] })),
  };

  let checkoutCounter = 0;
  const checkoutApi: CheckoutApiPort = {
    createCheckout: vi.fn(async (req, idempotencyKey) => {
      checkoutCreateCalls.push({
        body: req as unknown as Record<string, unknown>,
        idempotencyKey,
      });
      if (req.currency !== undefined && req.currency !== "USD") {
        const err = new Error("Unsupported currency") as Error & {
          status?: number;
          code?: string;
        };
        err.status = 400;
        err.code = "unsupported_currency";
        throw err;
      }
      const existing = checkoutsByOrderRef.get(req.order_ref);
      if (existing) {
        if (existing.subtotal_usd !== req.amount_usd) {
          const err = new Error("Order reference already exists with different amount") as Error & {
            status?: number;
            code?: string;
          };
          err.status = 409;
          err.code = "order_ref_taken";
          throw err;
        }
        return { status: 200, checkout: structuredClone(existing) };
      }
      checkoutCounter += 1;
      const mode = req.fee_mode ?? options.feeMode ?? "absorb";
      const subtotalCents = Math.round(Number(req.amount_usd) * 100);
      const feeCents =
        mode === "pass_to_customer"
          ? Math.ceil((subtotalCents * 25) / 10000)
          : 0;
      const totalCents = subtotalCents + feeCents;
      const subtotalUsd = (subtotalCents / 100).toFixed(2);
      const feeUsd = (feeCents / 100).toFixed(2);
      const totalUsd = (totalCents / 100).toFixed(2);
      const id = `chk-${checkoutCounter}`;
      const created = {
        id,
        token_id: id,
        order_ref: req.order_ref,
        amount_usd: totalUsd,
        subtotal_usd: subtotalUsd,
        fee_usd: feeUsd,
        total_usd: totalUsd,
        fee_mode: mode,
        amount_due: String(totalCents * 10_000),
        pay_url: `https://openrail.incepture.dev/c/${id}`,
        return_url: req.return_url ?? null,
        cancel_url: req.cancel_url ?? null,
        expires_at: new Date((currentNowSec + 3600) * 1000).toISOString(),
        status: "pending",
      };
      checkoutsByOrderRef.set(req.order_ref, created);
      return { status: 201, checkout: structuredClone(created) };
    }),
  };

  const tokenStore = new OrderTokenStore();
  const app = createShopifyApp({
    env: TEST_ENV,
    adminClient: adminClient as unknown as ShopifyAdminClient,
    paymentsAppClient: paymentsAppClient as unknown as ShopifyPaymentsAppClient,
    checkoutApi,
    tokenStore,
    clock: () => currentNowSec,
  });

  return {
    app,
    orders,
    adminClient,
    paymentsAppClient,
    checkoutApi,
    tokenStore,
    markPaidCalls,
    tagsAddCalls,
    orderNoteUpdates,
    resolvedSessions,
    rejectedSessions,
    checkoutCreateCalls,
    advanceClock: (seconds: number) => {
      currentNowSec += seconds;
    },
    nowSec: () => currentNowSec,
  };
}

describe("Shopify module — Blueprint required tests", () => {
  it("shopify_amount_from_admin_api_not_browser", async () => {
    const h = createTestHarness({
      order: makeOrder({
        id: "gid://shopify/Order/6001002003",
        name: "#1001",
        totalOutstandingSet: {
          shopMoney: { amount: "24.50", currencyCode: "USD" },
          presentmentMoney: { amount: "24.50", currencyCode: "USD" },
        },
      }),
    });

    const token = createOrderPayToken(
      {
        orderGid: "gid://shopify/Order/6001002003",
        orderName: "#1001",
        shopDomain: "openrail-dev.myshopify.com",
        nonce: "nonce-admin-amount-1",
        exp: h.nowSec() + 900,
      },
      TEST_ENV.SHOPIFY_ORDER_TOKEN_SECRET,
    );

    // Caller tries to tamper with amount, currency, and order_ref in query string and body
    const res = await h.app.handle({
      method: "GET",
      path: `/shopify/pay/${encodeURIComponent(token)}`,
      query: {
        amount: "0.01",
        amount_usd: "0.01",
        total: "0.01",
        currency: "EUR",
        order_ref: "HACKED-REF",
      },
      headers: {},
      rawBody: JSON.stringify({ amount_usd: "0.01" }),
    });

    expect(res.status).toBe(302);
    expect(res.headers?.location).toBe("https://openrail.incepture.dev/c/chk-1");
    expect(h.adminClient.getOrder).toHaveBeenCalledWith("gid://shopify/Order/6001002003");
    expect(h.checkoutCreateCalls).toHaveLength(1);
    // Must use 24.50 from Shopify Admin API totalOutstandingSet.shopMoney.amount, never 0.01
    expect(h.checkoutCreateCalls[0]?.body.amount_usd).toBe("24.50");
    expect(h.checkoutCreateCalls[0]?.body.order_ref).toBe("shopify-6001002003");
  });

  it("shopify_order_token_single_use", async () => {
    const h = createTestHarness();
    const token = createOrderPayToken(
      {
        orderGid: "gid://shopify/Order/6001002003",
        orderName: "#1001",
        shopDomain: "openrail-dev.myshopify.com",
        nonce: "nonce-single-use-1",
        exp: h.nowSec() + 900,
      },
      TEST_ENV.SHOPIFY_ORDER_TOKEN_SECRET,
    );

    // First use succeeds and redirects to hosted pay page
    const first = await h.app.handle({
      method: "GET",
      path: `/shopify/pay/${encodeURIComponent(token)}`,
      query: {},
      headers: {},
      rawBody: "",
    });
    expect(first.status).toBe(302);

    // Second use of the exact same token is refused with 410 order_token_already_used
    const second = await h.app.handle({
      method: "GET",
      path: `/shopify/pay/${encodeURIComponent(token)}`,
      query: {},
      headers: {},
      rawBody: "",
    });
    expect(second.status).toBe(410);
    expect(second.body.error?.code).toBe("order_token_already_used");

    // Tampered token signature is refused with 401 invalid_order_token
    const tampered = `${token.slice(0, -4)}ffff`;
    const third = await h.app.handle({
      method: "GET",
      path: `/shopify/pay/${encodeURIComponent(tampered)}`,
      query: {},
      headers: {},
      rawBody: "",
    });
    expect(third.status).toBe(401);
    expect(third.body.error?.code).toBe("invalid_order_token");

    // Expired token is refused with 401 expired_order_token
    const expiredToken = createOrderPayToken(
      {
        orderGid: "gid://shopify/Order/6001002003",
        orderName: "#1001",
        shopDomain: "openrail-dev.myshopify.com",
        nonce: "nonce-expired-1",
        exp: h.nowSec() - 10,
      },
      TEST_ENV.SHOPIFY_ORDER_TOKEN_SECRET,
    );
    const fourth = await h.app.handle({
      method: "GET",
      path: `/shopify/pay/${encodeURIComponent(expiredToken)}`,
      query: {},
      headers: {},
      rawBody: "",
    });
    expect(fourth.status).toBe(401);
    expect(fourth.body.error?.code).toBe("expired_order_token");
  });

  it("shopify_mark_paid_only_on_full_payment", async () => {
    const h = createTestHarness({
      order: makeOrder({
        id: "gid://shopify/Order/6001002003",
        name: "#1001",
        totalOutstandingSet: {
          shopMoney: { amount: "12.00", currencyCode: "USD" },
          presentmentMoney: { amount: "12.00", currencyCode: "USD" },
        },
      }),
      feeMode: "pass_to_customer",
    });

    // Create checkout first (subtotal $12.00, fee $0.03, total $12.03)
    const token = createOrderPayToken(
      {
        orderGid: "gid://shopify/Order/6001002003",
        orderName: "#1001",
        shopDomain: "openrail-dev.myshopify.com",
        nonce: "nonce-full-pay-1",
        exp: h.nowSec() + 900,
      },
      TEST_ENV.SHOPIFY_ORDER_TOKEN_SECRET,
    );
    await h.app.handle({
      method: "GET",
      path: `/shopify/pay/${encodeURIComponent(token)}`,
      query: {},
      headers: {},
      rawBody: "",
    });

    // Case 1: Underpaid webhook (e.g. only $12.00 paid when $12.03 was required due to pass_to_customer fee)
    const underpaidBody = JSON.stringify({
      id: "evt_underpaid_1",
      type: "checkout.paid",
      created: h.nowSec(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-6001002003",
        subtotal_usd: "12.00",
        fee_usd: "0.03",
        total_usd: "12.03",
        amount_usd: "12.00", // Less than required 12.03!
        fee_mode: "pass_to_customer",
        status: "paid",
      },
    });
    const resUnderpaid = await h.app.handle({
      method: "POST",
      path: "/shopify/webhooks/openrail",
      query: {},
      headers: {
        "openrail-signature": signOpenrailWebhook(
          TEST_ENV.OPENRAIL_WEBHOOK_SECRET,
          h.nowSec(),
          underpaidBody,
        ),
      },
      rawBody: underpaidBody,
    });
    expect(resUnderpaid.status).toBe(409);
    expect(resUnderpaid.body.error?.code).toBe("insufficient_payment_amount");
    expect(h.markPaidCalls).toHaveLength(0);

    // Case 2: Full payment ($12.03) marks the order paid in Shopify via orderMarkAsPaid
    const fullPaidBody = JSON.stringify({
      id: "evt_fullpaid_1",
      type: "checkout.paid",
      created: h.nowSec(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-6001002003",
        subtotal_usd: "12.00",
        fee_usd: "0.03",
        total_usd: "12.03",
        amount_usd: "12.03",
        fee_mode: "pass_to_customer",
        booking_tx: "8fJ3kLmN9pQrStUvWxYz",
        origin_tx: "0xabc123def456",
        status: "paid",
      },
    });
    const resFull = await h.app.handle({
      method: "POST",
      path: "/shopify/webhooks/openrail",
      query: {},
      headers: {
        "openrail-signature": signOpenrailWebhook(
          TEST_ENV.OPENRAIL_WEBHOOK_SECRET,
          h.nowSec(),
          fullPaidBody,
        ),
      },
      rawBody: fullPaidBody,
    });
    expect(resFull.status).toBe(200);
    expect(h.markPaidCalls).toEqual(["gid://shopify/Order/6001002003"]);
    expect(h.tagsAddCalls).toContainEqual({
      id: "gid://shopify/Order/6001002003",
      tags: ["openrail-paid"],
    });
  });

  it("shopify_partial_tagged_not_paid", async () => {
    const h = createTestHarness();
    const token = createOrderPayToken(
      {
        orderGid: "gid://shopify/Order/6001002003",
        orderName: "#1001",
        shopDomain: "openrail-dev.myshopify.com",
        nonce: "nonce-partial-1",
        exp: h.nowSec() + 900,
      },
      TEST_ENV.SHOPIFY_ORDER_TOKEN_SECRET,
    );
    await h.app.handle({
      method: "GET",
      path: `/shopify/pay/${encodeURIComponent(token)}`,
      query: {},
      headers: {},
      rawBody: "",
    });

    const partialBody = JSON.stringify({
      id: "evt_partial_1",
      type: "checkout.partial",
      created: h.nowSec(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-6001002003",
        amount_usd: "2.00",
        subtotal_usd: "2.00",
        fee_usd: "0.00",
        total_usd: "2.00",
        due: "2000000",
        received: "1000000",
        remaining: "1000000",
        status: "partial",
      },
    });

    const res = await h.app.handle({
      method: "POST",
      path: "/shopify/webhooks/openrail",
      query: {},
      headers: {
        "openrail-signature": signOpenrailWebhook(
          TEST_ENV.OPENRAIL_WEBHOOK_SECRET,
          h.nowSec(),
          partialBody,
        ),
      },
      rawBody: partialBody,
    });

    expect(res.status).toBe(200);
    // NEVER calls orderMarkAsPaid
    expect(h.markPaidCalls).toHaveLength(0);
    // Adds tag openrail-partial and note with amounts
    expect(h.tagsAddCalls).toEqual([
      { id: "gid://shopify/Order/6001002003", tags: ["openrail-partial"] },
    ]);
    expect(h.orderNoteUpdates).toHaveLength(1);
    expect(h.orderNoteUpdates[0]?.note).toContain("partial payment received (1.00 USD)");
    expect(h.orderNoteUpdates[0]?.note).toContain("1.00 USD still due");
  });

  it("shopify_mark_paid_idempotent", async () => {
    const h = createTestHarness();
    const token = createOrderPayToken(
      {
        orderGid: "gid://shopify/Order/6001002003",
        orderName: "#1001",
        shopDomain: "openrail-dev.myshopify.com",
        nonce: "nonce-idem-1",
        exp: h.nowSec() + 900,
      },
      TEST_ENV.SHOPIFY_ORDER_TOKEN_SECRET,
    );
    await h.app.handle({
      method: "GET",
      path: `/shopify/pay/${encodeURIComponent(token)}`,
      query: {},
      headers: {},
      rawBody: "",
    });

    const paidBody = JSON.stringify({
      id: "evt_paid_same_id_1",
      type: "checkout.paid",
      created: h.nowSec(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-6001002003",
        amount_usd: "2.00",
        subtotal_usd: "2.00",
        fee_usd: "0.00",
        total_usd: "2.00",
        status: "paid",
      },
    });
    const sig = signOpenrailWebhook(
      TEST_ENV.OPENRAIL_WEBHOOK_SECRET,
      h.nowSec(),
      paidBody,
    );

    // First delivery marks the order paid
    const first = await h.app.handle({
      method: "POST",
      path: "/shopify/webhooks/openrail",
      query: {},
      headers: { "openrail-signature": sig },
      rawBody: paidBody,
    });
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();
    expect(h.markPaidCalls).toHaveLength(1);

    // Second delivery with the same event ID is deduplicated and makes zero Admin API calls
    const second = await h.app.handle({
      method: "POST",
      path: "/shopify/webhooks/openrail",
      query: {},
      headers: { "openrail-signature": sig },
      rawBody: paidBody,
    });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(h.markPaidCalls).toHaveLength(1);

    // Third delivery with a different event ID for an already-paid order is also a safe no-op
    const paidBody2 = JSON.stringify({
      id: "evt_paid_second_id_2",
      type: "checkout.paid",
      created: h.nowSec(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-6001002003",
        amount_usd: "2.00",
        subtotal_usd: "2.00",
        fee_usd: "0.00",
        total_usd: "2.00",
        status: "paid",
      },
    });
    const third = await h.app.handle({
      method: "POST",
      path: "/shopify/webhooks/openrail",
      query: {},
      headers: {
        "openrail-signature": signOpenrailWebhook(
          TEST_ENV.OPENRAIL_WEBHOOK_SECRET,
          h.nowSec(),
          paidBody2,
        ),
      },
      rawBody: paidBody2,
    });
    expect(third.status).toBe(200);
    expect(h.markPaidCalls).toHaveLength(1);
  });

  it("shopify_non_usd_refused", async () => {
    // 1. Store install check refuses a EUR shop
    const eurHarness = createTestHarness({
      shop: makeUsdShop({ currencyCode: "EUR" }),
    });
    const installRes = await eurHarness.app.handle({
      method: "POST",
      path: "/shopify/install/check",
      query: {},
      headers: {},
      rawBody: "",
    });
    expect(installRes.status).toBe(422);
    expect(installRes.body.error?.code).toBe("unsupported_currency");

    // 2. Order pay redirect refuses an order whose totalOutstandingSet.shopMoney.currencyCode is CAD
    const cadOrderHarness = createTestHarness({
      order: makeOrder({
        currencyCode: "CAD",
        presentmentCurrencyCode: "CAD",
        totalOutstandingSet: {
          shopMoney: { amount: "10.00", currencyCode: "CAD" },
          presentmentMoney: { amount: "10.00", currencyCode: "CAD" },
        },
      }),
    });
    const token = createOrderPayToken(
      {
        orderGid: "gid://shopify/Order/6001002003",
        orderName: "#1001",
        shopDomain: "openrail-dev.myshopify.com",
        nonce: "nonce-cad-1",
        exp: cadOrderHarness.nowSec() + 900,
      },
      TEST_ENV.SHOPIFY_ORDER_TOKEN_SECRET,
    );
    const payRes = await cadOrderHarness.app.handle({
      method: "GET",
      path: `/shopify/pay/${encodeURIComponent(token)}`,
      query: {},
      headers: {},
      rawBody: "",
    });
    expect(payRes.status).toBe(422);
    expect(payRes.body.error?.code).toBe("unsupported_currency");
    expect(cadOrderHarness.checkoutCreateCalls).toHaveLength(0);

    // 3. Offsite payment session refuses non-USD currency
    const sessionBody = JSON.stringify({
      id: "sess_eur_1",
      gid: "gid://shopify/PaymentSession/sess_eur_1",
      group: "group_eur_1",
      amount: "15.00",
      currency: "EUR",
      test: true,
      kind: "sale",
      cancel_url: "https://openrail-dev.myshopify.com/checkouts/cn/123",
    });
    const sessionRes = await eurHarness.app.handle({
      method: "POST",
      path: "/shopify/payment_session",
      query: {},
      headers: {
        "x-shopify-hmac-sha256": signShopifyWebhookHmac(
          sessionBody,
          TEST_ENV.SHOPIFY_WEBHOOK_SECRET,
        ),
        "shopify-shop-domain": "openrail-dev.myshopify.com",
      },
      rawBody: sessionBody,
    });
    expect(sessionRes.status).toBe(422);
    expect(sessionRes.body.error?.code).toBe("unsupported_currency");
  });
});

describe("Shopify module — Webhooks, Session Idempotency, Paid-Late & Offsite Flow", () => {
  it("verifies Shopify webhook X-Shopify-Hmac-Sha256 and Openrail-Signature headers", () => {
    const rawBody = JSON.stringify({ id: 6001002003, name: "#1001", total_price: "2.00" });
    const validShopifyHmac = createHmac("sha256", TEST_ENV.SHOPIFY_WEBHOOK_SECRET)
      .update(rawBody, "utf8")
      .digest("base64");

    expect(
      verifyShopifyWebhookHmac(rawBody, validShopifyHmac, TEST_ENV.SHOPIFY_WEBHOOK_SECRET),
    ).toBe(true);
    expect(
      verifyShopifyWebhookHmac(rawBody, "bad_hmac", TEST_ENV.SHOPIFY_WEBHOOK_SECRET),
    ).toBe(false);
    expect(
      verifyShopifyWebhookHmac(`${rawBody} `, validShopifyHmac, TEST_ENV.SHOPIFY_WEBHOOK_SECRET),
    ).toBe(false);

    const ts = 1_762_700_000;
    const openrailSig = signOpenrailWebhook(TEST_ENV.OPENRAIL_WEBHOOK_SECRET, ts, rawBody);
    expect(
      verifyOpenrailWebhookSignature(
        rawBody,
        openrailSig,
        [TEST_ENV.OPENRAIL_WEBHOOK_SECRET],
        300,
        ts + 120,
      ),
    ).toBe(true);
    // Outside 300s replay window fails
    expect(
      verifyOpenrailWebhookSignature(
        rawBody,
        openrailSig,
        [TEST_ENV.OPENRAIL_WEBHOOK_SECRET],
        300,
        ts + 301,
      ),
    ).toBe(false);
  });

  it("handles Shopify orders/create webhook, verifies HMAC, and issues a single-use pay URL", async () => {
    const h = createTestHarness();
    const webhookPayload = JSON.stringify({
      id: 6001002003,
      admin_graphql_api_id: "gid://shopify/Order/6001002003",
      name: "#1001",
      currency: "USD",
      financial_status: "pending",
      payment_gateway_names: ["Pay with stablecoins (Openrail)"],
      order_status_url: "https://openrail-dev.myshopify.com/6001002003/orders/abc123status",
    });

    // Unsigned webhook is rejected with 401
    const badRes = await h.app.handle({
      method: "POST",
      path: "/shopify/webhooks/orders-create",
      query: {},
      headers: {
        "x-shopify-hmac-sha256": "invalid",
        "x-shopify-shop-domain": "openrail-dev.myshopify.com",
      },
      rawBody: webhookPayload,
    });
    expect(badRes.status).toBe(401);

    // Signed webhook issues a pay URL with a valid token
    const goodRes = await h.app.handle({
      method: "POST",
      path: "/shopify/webhooks/orders-create",
      query: {},
      headers: {
        "x-shopify-hmac-sha256": signShopifyWebhookHmac(
          webhookPayload,
          TEST_ENV.SHOPIFY_WEBHOOK_SECRET,
        ),
        "x-shopify-shop-domain": "openrail-dev.myshopify.com",
      },
      rawBody: webhookPayload,
    });
    expect(goodRes.status).toBe(200);
    expect(typeof goodRes.body.pay_url).toBe("string");
    expect(String(goodRes.body.pay_url)).toContain("/shopify/pay/");

    // Following the issued pay_url creates the Openrail checkout with expected fields
    const payPath = new URL(String(goodRes.body.pay_url)).pathname;
    const redirectRes = await h.app.handle({
      method: "GET",
      path: payPath,
      query: {},
      headers: {},
      rawBody: "",
    });
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers?.location).toBe("https://openrail.incepture.dev/c/chk-1");
    expect(h.checkoutCreateCalls[0]?.body).toMatchObject({
      order_ref: "shopify-6001002003",
      amount_usd: "2.00",
      currency: "USD",
      expires_in_minutes: 60,
      return_url: "https://openrail-dev.myshopify.com/6001002003/orders/abc123status",
      cancel_url: "https://openrail-dev.myshopify.com/6001002003/orders/abc123status",
    });
  });

  it("handles checkout.paid_late without marking order paid or resolving payment session, and notifies merchant", async () => {
    const h = createTestHarness();
    // Start via offsite payment session
    const sessionPayload = JSON.stringify({
      id: "sess_late_1",
      gid: "gid://shopify/PaymentSession/sess_late_1",
      group: "group_6001002003",
      amount: "2.00",
      currency: "USD",
      test: true,
      kind: "sale",
      order_gid: "gid://shopify/Order/6001002003",
      cancel_url: "https://openrail-dev.myshopify.com/checkouts/cn/123",
    });
    const sessionRes = await h.app.handle({
      method: "POST",
      path: "/shopify/payment_session",
      query: {},
      headers: {
        "x-shopify-hmac-sha256": signShopifyWebhookHmac(
          sessionPayload,
          TEST_ENV.SHOPIFY_WEBHOOK_SECRET,
        ),
        "shopify-shop-domain": "openrail-dev.myshopify.com",
      },
      rawBody: sessionPayload,
    });
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.body.redirect_url).toBe("https://openrail.incepture.dev/c/chk-1");

    // Repeated session with the same group/order_ref is idempotent and returns the same redirect_url
    const repeatSessionRes = await h.app.handle({
      method: "POST",
      path: "/shopify/payment_session",
      query: {},
      headers: {
        "x-shopify-hmac-sha256": signShopifyWebhookHmac(
          sessionPayload,
          TEST_ENV.SHOPIFY_WEBHOOK_SECRET,
        ),
        "shopify-shop-domain": "openrail-dev.myshopify.com",
      },
      rawBody: sessionPayload,
    });
    expect(repeatSessionRes.status).toBe(200);
    expect(repeatSessionRes.body.redirect_url).toBe("https://openrail.incepture.dev/c/chk-1");

    // Deliver checkout.paid_late
    const lateBody = JSON.stringify({
      id: "evt_late_1",
      type: "checkout.paid_late",
      created: h.nowSec(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-group-group_6001002003",
        amount_usd: "2.00",
        subtotal_usd: "2.00",
        fee_usd: "0.00",
        total_usd: "2.00",
        held_amount: "2000000",
        status: "late",
      },
    });
    const lateRes = await h.app.handle({
      method: "POST",
      path: "/shopify/webhooks/openrail",
      query: {},
      headers: {
        "openrail-signature": signOpenrailWebhook(
          TEST_ENV.OPENRAIL_WEBHOOK_SECRET,
          h.nowSec(),
          lateBody,
        ),
      },
      rawBody: lateBody,
    });

    expect(lateRes.status).toBe(200);
    // Must NOT mark order paid and must NOT resolve payment session on late payment
    expect(h.markPaidCalls).toHaveLength(0);
    expect(h.resolvedSessions).toHaveLength(0);
    // Must tag openrail-late and add merchant notice in order note
    expect(h.tagsAddCalls).toContainEqual({
      id: "gid://shopify/Order/6001002003",
      tags: ["openrail-late"],
    });
    expect(h.orderNoteUpdates[0]?.note).toContain("paid after the checkout expired (2.00 USD)");
    expect(h.orderNoteUpdates[0]?.note).toContain("Openrail dashboard");
  });

  it("resolves offsite payment session and marks order paid when checkout.paid or checkout.accepted arrives", async () => {
    const h = createTestHarness();
    const sessionPayload = JSON.stringify({
      id: "sess_ok_1",
      gid: "gid://shopify/PaymentSession/sess_ok_1",
      group: "group_ok_1",
      amount: "2.00",
      currency: "USD",
      test: true,
      kind: "sale",
      order_gid: "gid://shopify/Order/6001002003",
      cancel_url: "https://openrail-dev.myshopify.com/checkouts/cn/123",
    });
    await h.app.handle({
      method: "POST",
      path: "/shopify/payment_session",
      query: {},
      headers: {
        "x-shopify-hmac-sha256": signShopifyWebhookHmac(
          sessionPayload,
          TEST_ENV.SHOPIFY_WEBHOOK_SECRET,
        ),
        "shopify-shop-domain": "openrail-dev.myshopify.com",
      },
      rawBody: sessionPayload,
    });

    const paidBody = JSON.stringify({
      id: "evt_paid_sess_1",
      type: "checkout.paid",
      created: h.nowSec(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-group-group_ok_1",
        amount_usd: "2.00",
        subtotal_usd: "2.00",
        fee_usd: "0.00",
        total_usd: "2.00",
        booking_tx: "tx_near_999",
        status: "paid",
      },
    });
    const res = await h.app.handle({
      method: "POST",
      path: "/shopify/webhooks/openrail",
      query: {},
      headers: {
        "openrail-signature": signOpenrailWebhook(
          TEST_ENV.OPENRAIL_WEBHOOK_SECRET,
          h.nowSec(),
          paidBody,
        ),
      },
      rawBody: paidBody,
    });
    expect(res.status).toBe(200);
    expect(h.resolvedSessions).toEqual([
      {
        id: "gid://shopify/PaymentSession/sess_ok_1",
        networkTransactionId: "tx_near_999",
      },
    ]);
    expect(h.markPaidCalls).toEqual(["gid://shopify/Order/6001002003"]);
  });

  it("handles checkout.accepted, checkout.refund_started, and flagged checkouts", async () => {
    const h = createTestHarness();
    const token = createOrderPayToken(
      {
        orderGid: "gid://shopify/Order/6001002003",
        orderName: "#1001",
        shopDomain: "openrail-dev.myshopify.com",
        nonce: "nonce-lifecycle-1",
        exp: h.nowSec() + 900,
      },
      TEST_ENV.SHOPIFY_ORDER_TOKEN_SECRET,
    );
    await h.app.handle({
      method: "GET",
      path: `/shopify/pay/${encodeURIComponent(token)}`,
      query: {},
      headers: {},
      rawBody: "",
    });

    // 1. Flagged checkout event adds openrail-needs-attention tag and note
    const flaggedBody = JSON.stringify({
      id: "evt_flagged_1",
      type: "checkout.paid_late",
      created: h.nowSec(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-6001002003",
        amount_usd: "2.00",
        total_usd: "2.00",
        flagged: true,
        status: "needs_attention",
      },
    });
    await h.app.handle({
      method: "POST",
      path: "/shopify/webhooks/openrail",
      query: {},
      headers: {
        "openrail-signature": signOpenrailWebhook(
          TEST_ENV.OPENRAIL_WEBHOOK_SECRET,
          h.nowSec(),
          flaggedBody,
        ),
      },
      rawBody: flaggedBody,
    });
    expect(h.tagsAddCalls).toContainEqual({
      id: "gid://shopify/Order/6001002003",
      tags: ["openrail-needs-attention"],
    });

    // 2. checkout.refund_started adds openrail-refund-started tag and note
    const refundBody = JSON.stringify({
      id: "evt_refund_1",
      type: "checkout.refund_started",
      created: h.nowSec(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-6001002003",
        amount_usd: "2.00",
        total_usd: "2.00",
        refund_to: "0x71C...89A",
        status: "refund_started",
      },
    });
    await h.app.handle({
      method: "POST",
      path: "/shopify/webhooks/openrail",
      query: {},
      headers: {
        "openrail-signature": signOpenrailWebhook(
          TEST_ENV.OPENRAIL_WEBHOOK_SECRET,
          h.nowSec(),
          refundBody,
        ),
      },
      rawBody: refundBody,
    });
    expect(h.tagsAddCalls).toContainEqual({
      id: "gid://shopify/Order/6001002003",
      tags: ["openrail-refund-started"],
    });

    // 3. checkout.accepted marks the order paid and adds openrail-accepted tag
    const acceptedBody = JSON.stringify({
      id: "evt_accepted_1",
      type: "checkout.accepted",
      created: h.nowSec(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-6001002003",
        amount_usd: "2.00",
        total_usd: "2.00",
        status: "accepted",
      },
    });
    await h.app.handle({
      method: "POST",
      path: "/shopify/webhooks/openrail",
      query: {},
      headers: {
        "openrail-signature": signOpenrailWebhook(
          TEST_ENV.OPENRAIL_WEBHOOK_SECRET,
          h.nowSec(),
          acceptedBody,
        ),
      },
      rawBody: acceptedBody,
    });
    expect(h.markPaidCalls).toEqual(["gid://shopify/Order/6001002003"]);
    expect(h.tagsAddCalls).toContainEqual({
      id: "gid://shopify/Order/6001002003",
      tags: ["openrail-accepted"],
    });
  });

  it("enforces MISSING_ENV guard without printing secret values and parses CRLF env files", () => {
    expect(() => loadShopifyAppEnv(undefined, {})).toThrow("MISSING_ENV: SHOPIFY_SHOP_DOMAIN");
    expect(() =>
      loadShopifyAppEnv(undefined, {
        ...TEST_ENV,
        OPENRAIL_API_KEY: "",
      }),
    ).toThrow("MISSING_ENV: OPENRAIL_API_KEY");
  });

  it("builds Checkout UI Extension thank-you block model without exposing amount parameters in URL", () => {
    const unpaidUsd = buildThankYouBlockModel({
      orderTokenUrl: "https://shopify.openrail.incepture.dev/shopify/pay/tok_abc",
      orderName: "#1001",
      amountUsd: "2.00",
      currencyCode: "USD",
      isPaid: false,
    });
    expect(unpaidUsd.visible).toBe(true);
    expect(unpaidUsd.ctaHref).toBe("https://shopify.openrail.incepture.dev/shopify/pay/tok_abc");
    expect(unpaidUsd.ctaHref).not.toContain("amount");

    const alreadyPaid = buildThankYouBlockModel({
      orderTokenUrl: "https://shopify.openrail.incepture.dev/shopify/pay/tok_abc",
      orderName: "#1001",
      amountUsd: "2.00",
      currencyCode: "USD",
      isPaid: true,
    });
    expect(alreadyPaid.visible).toBe(false);
  });

  it("sends verified GraphQL queries and mutations in ShopifyAdminClient and ShopifyPaymentsAppClient", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: { query: string; variables?: Record<string, unknown> } }> = [];
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      calls.push({ url, headers, body });

      if (body.query.includes("orderMarkAsPaid")) {
        return new Response(
          JSON.stringify({
            data: {
              orderMarkAsPaid: {
                order: {
                  id: "gid://shopify/Order/6001002003",
                  name: "#1001",
                  displayFinancialStatus: "PAID",
                  fullyPaid: true,
                },
                userErrors: [],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (body.query.includes("paymentSessionResolve")) {
        return new Response(
          JSON.stringify({
            data: {
              paymentSessionResolve: {
                paymentSession: {
                  id: "gid://shopify/PaymentSession/sess_1",
                  nextAction: {
                    action: "REDIRECT",
                    context: { redirectUrl: "https://openrail-dev.myshopify.com/orders/1" },
                  },
                },
                userErrors: [],
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });

    const admin = new ShopifyAdminClient({
      shopDomain: "openrail-dev.myshopify.com",
      accessToken: "shpat_test_123",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    const resPaid = await admin.markOrderAsPaid("gid://shopify/Order/6001002003");
    expect(resPaid.order?.fullyPaid).toBe(true);
    expect(calls[0]?.url).toBe(
      "https://openrail-dev.myshopify.com/admin/api/2025-10/graphql.json",
    );
    expect(calls[0]?.headers["X-Shopify-Access-Token"]).toBe("shpat_test_123");
    expect(calls[0]?.body.variables).toEqual({
      input: { id: "gid://shopify/Order/6001002003" },
    });

    const paymentsApp = new ShopifyPaymentsAppClient({
      shopDomain: "openrail-dev.myshopify.com",
      accessToken: "shpat_test_123",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    const resSession = await paymentsApp.paymentSessionResolve(
      "gid://shopify/PaymentSession/sess_1",
      "near_tx_123",
    );
    expect(resSession.redirectUrl).toBe("https://openrail-dev.myshopify.com/orders/1");
    expect(calls[1]?.url).toBe(
      "https://openrail-dev.myshopify.com/payments_apps/api/2025-10/graphql.json",
    );
    expect(calls[1]?.body.variables).toEqual({
      id: "gid://shopify/PaymentSession/sess_1",
      networkTransactionId: "near_tx_123",
    });
  });

  describe("Dev Dashboard client credentials grant (24-hour token exchange)", () => {
    it("shopify_client_credentials_token_fetched_once_and_reused", async () => {
      let tokenCallCount = 0;
      let graphqlCallCount = 0;
      const capturedAuthHeaders: string[] = [];

      const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/oauth/access_token")) {
          tokenCallCount += 1;
          const bodyStr = String(init?.body ?? "");
          expect(bodyStr).toContain("grant_type=client_credentials");
          expect(bodyStr).toContain("client_id=cid_test_123");
          expect(bodyStr).toContain("client_secret=csec_test_456");
          return new Response(
            JSON.stringify({
              access_token: "shpat_live_token_abc123",
              scope: "read_orders,write_orders",
              expires_in: 86399,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/admin/api/2025-10/graphql.json")) {
          graphqlCallCount += 1;
          const headers = (init?.headers ?? {}) as Record<string, string>;
          capturedAuthHeaders.push(headers["X-Shopify-Access-Token"] ?? "");
          return new Response(
            JSON.stringify({
              data: {
                shop: {
                  name: "My Store",
                  currencyCode: "USD",
                  myshopifyDomain: "openrail-dev.myshopify.com",
                  primaryDomain: { url: "https://openrail-dev.myshopify.com", host: "openrail-dev.myshopify.com" },
                },
              },
            }),
            { status: 200 },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new ShopifyAdminClient({
        shopDomain: "openrail-dev.myshopify.com",
        clientId: "cid_test_123",
        clientSecret: "csec_test_456",
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      // 3 calls to GraphQL API
      await client.getShop();
      await client.getShop();
      await client.getShop();

      // Token endpoint must only be called ONCE
      expect(tokenCallCount).toBe(1);
      expect(graphqlCallCount).toBe(3);
      expect(capturedAuthHeaders).toEqual([
        "shpat_live_token_abc123",
        "shpat_live_token_abc123",
        "shpat_live_token_abc123",
      ]);
    });

    it("shopify_client_credentials_refetched_after_expiry", async () => {
      let currentSec = 1_000_000;
      let tokenCallCount = 0;

      const mockFetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/admin/oauth/access_token")) {
          tokenCallCount += 1;
          return new Response(
            JSON.stringify({
              access_token: `token_v${tokenCallCount}`,
              expires_in: 86399,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            data: {
              shop: {
                name: "Store",
                currencyCode: "USD",
                myshopifyDomain: "openrail-dev.myshopify.com",
                primaryDomain: { url: "https://openrail-dev.myshopify.com", host: "openrail-dev.myshopify.com" },
              },
            },
          }),
          { status: 200 },
        );
      });

      const client = new ShopifyAdminClient({
        shopDomain: "openrail-dev.myshopify.com",
        clientId: "cid_1",
        clientSecret: "csec_1",
        fetchImpl: mockFetch as unknown as typeof fetch,
        clock: () => currentSec,
      });

      await client.getShop();
      expect(tokenCallCount).toBe(1);

      // Within 24 hours (e.g. 5 hours later): reused
      currentSec += 5 * 3600;
      await client.getShop();
      expect(tokenCallCount).toBe(1);

      // Past expiration (expires_in is 86399, buffer is 60s -> after 86340s it refetches)
      currentSec += 20 * 3600; // total 25 hours later
      await client.getShop();
      expect(tokenCallCount).toBe(2);
    });

    it("shopify_client_credentials_refetched_after_401", async () => {
      let tokenCallCount = 0;
      let graphqlAttempts = 0;

      const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/oauth/access_token")) {
          tokenCallCount += 1;
          return new Response(
            JSON.stringify({
              access_token: `fresh_token_${tokenCallCount}`,
              expires_in: 86399,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/admin/api/2025-10/graphql.json")) {
          graphqlAttempts += 1;
          const headers = (init?.headers ?? {}) as Record<string, string>;
          // First attempt gets 401 Unauthorized
          if (graphqlAttempts === 1) {
            expect(headers["X-Shopify-Access-Token"]).toBe("fresh_token_1");
            return new Response("Unauthorized", { status: 401 });
          }
          // Retry with fresh token succeeds
          expect(headers["X-Shopify-Access-Token"]).toBe("fresh_token_2");
          return new Response(
            JSON.stringify({
              data: {
                shop: {
                  name: "Store",
                  currencyCode: "USD",
                  myshopifyDomain: "openrail-dev.myshopify.com",
                  primaryDomain: { url: "https://openrail-dev.myshopify.com", host: "openrail-dev.myshopify.com" },
                },
              },
            }),
            { status: 200 },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new ShopifyAdminClient({
        shopDomain: "openrail-dev.myshopify.com",
        clientId: "cid_1",
        clientSecret: "csec_1",
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const shop = await client.getShop();
      expect(shop.name).toBe("Store");
      expect(tokenCallCount).toBe(2);
      expect(graphqlAttempts).toBe(2);
    });

    it("shopify_client_credentials_failing_exchange_named_error_no_secret", async () => {
      const superSecret = "super_secret_never_leak_xyz_987";
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: "invalid_client",
            error_description: "Client authentication failed",
          }),
          { status: 401 },
        );
      });

      const client = new ShopifyAdminClient({
        shopDomain: "openrail-dev.myshopify.com",
        clientId: "bad_client_id",
        clientSecret: superSecret,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      let caughtError: Error | undefined;
      try {
        await client.getShop();
      } catch (err) {
        caughtError = err as Error;
      }

      expect(caughtError).toBeDefined();
      expect(caughtError?.message).toContain("token_exchange_failed");
      expect(caughtError?.message).not.toContain(superSecret);
    });

    it("shopify_static_token_override_still_works", async () => {
      let tokenEndpointCalled = false;
      const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/oauth/access_token")) {
          tokenEndpointCalled = true;
          return new Response("Should not be called", { status: 500 });
        }
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers["X-Shopify-Access-Token"]).toBe("shpat_legacy_override_123");
        return new Response(
          JSON.stringify({
            data: {
              shop: {
                name: "Legacy Store",
                currencyCode: "USD",
                myshopifyDomain: "openrail-dev.myshopify.com",
                primaryDomain: { url: "https://openrail-dev.myshopify.com", host: "openrail-dev.myshopify.com" },
              },
            },
          }),
          { status: 200 },
        );
      });

      const client = new ShopifyAdminClient({
        shopDomain: "openrail-dev.myshopify.com",
        accessToken: "shpat_legacy_override_123",
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const shop = await client.getShop();
      expect(shop.name).toBe("Legacy Store");
      expect(tokenEndpointCalled).toBe(false);
    });

    it("shopify_app_health_endpoint", async () => {
      const h = createTestHarness();
      const res = await h.app.handle({
        method: "GET",
        path: "/health",
        query: {},
        headers: {},
        rawBody: "",
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("shopify_http_listener_handles_requests_and_payload_limits", async () => {
      const h = createTestHarness();
      const listener = createShopifyHttpListener(h.app);

      // 1. Health check via HTTP listener
      const mockReq: any = {
        method: "GET",
        url: "/health",
        headers: { host: "127.0.0.1:8083" },
        async *[Symbol.asyncIterator]() {},
      };
      let status = 0;
      let headersWritten: Record<string, string> = {};
      let bodyData = "";
      const mockRes: any = {
        writeHead: vi.fn((s: number, h: Record<string, string>) => {
          status = s;
          headersWritten = h;
        }),
        end: vi.fn((data?: string) => {
          if (data) bodyData = data;
        }),
      };

      await listener(mockReq, mockRes);
      expect(status).toBe(200);
      expect(JSON.parse(bodyData)).toEqual({ ok: true });

      // 2. Payload limit check (> 1 MB)
      const bigChunk = Buffer.alloc(1024 * 1024 + 10, "a");
      const bigReq: any = {
        method: "POST",
        url: "/shopify/webhooks/openrail",
        headers: { host: "127.0.0.1:8083" },
        async *[Symbol.asyncIterator]() {
          yield bigChunk;
        },
      };
      let bigStatus = 0;
      let bigBody = "";
      const bigRes: any = {
        writeHead: vi.fn((s: number) => {
          bigStatus = s;
        }),
        end: vi.fn((data?: string) => {
          if (data) bigBody = data;
        }),
      };
      await listener(bigReq, bigRes);
      expect(bigStatus).toBe(413);
      expect(JSON.parse(bigBody).error.code).toBe("payload_too_large");
    });

    it("shopify_server_pack_includes_service_and_unit", () => {
      const currentDir = typeof __dirname !== "undefined"
        ? __dirname
        : dirname(fileURLToPath(import.meta.url));

      // 1. Verify package.json specifies @openrail/shopify
      const pkgPath = resolve(currentDir, "../package.json");
      expect(existsSync(pkgPath)).toBe(true);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      expect(pkg.name).toBe("@openrail/shopify");

      // 2. Verify shopify.app.toml specifies configuration and webhooks
      const appTomlPath = resolve(currentDir, "../shopify.app.toml");
      expect(existsSync(appTomlPath)).toBe(true);
      const appToml = readFileSync(appTomlPath, "utf8");
      expect(appToml).toContain('application_url = "https://shopify.openrail.incepture.dev"');
      expect(appToml).toContain('scopes = "read_orders,write_orders"');
      expect(appToml).toContain('topics = [ "orders/create" ]');
      expect(appToml).toContain('uri = "https://shopify.openrail.incepture.dev/shopify/webhooks"');

      // 3. Verify systemd unit configuration matches services/shopify
      const findFile = (candidates: string[]): string => {
        for (const rel of candidates) {
          const candidatePath = resolve(currentDir, rel);
          if (existsSync(candidatePath)) return candidatePath;
        }
        return resolve(currentDir, candidates[0]!);
      };

      const unitPath = findFile([
        "../../../deploy/systemd/openrail-shopify.service",
        "../../deploy/systemd/openrail-shopify.service",
        "../deploy/systemd/openrail-shopify.service",
      ]);
      expect(existsSync(unitPath)).toBe(true);
      const unit = readFileSync(unitPath, "utf8");
      expect(unit).toContain("ConditionPathExists=/opt/openrail/current/services/shopify/src/server.ts");
      expect(unit).toContain("WorkingDirectory=/opt/openrail/current/services/shopify");
      expect(unit).toContain("ExecStart=/opt/openrail/current/node_modules/.bin/tsx src/server.ts");

      // 4. Verify tar pack listing matches deploy/PRIVATE-BUILD.md
      const envPath = findFile([
        "../../../deploy/env/shopify.env.example",
        "../../deploy/env/shopify.env.example",
        "../deploy/env/shopify.env.example",
      ]);
      expect(existsSync(envPath)).toBe(true);

      const tempDir = mkdtempSync(join(tmpdir(), "openrail-pack-test-"));
      try {
        const servicesDir = join(tempDir, "services/shopify/src");
        const deployDir = join(tempDir, "deploy/systemd");
        const envDir = join(tempDir, "deploy/env");
        mkdirSync(servicesDir, { recursive: true });
        mkdirSync(deployDir, { recursive: true });
        mkdirSync(envDir, { recursive: true });

        const scriptsDir = join(tempDir, "services/shopify/scripts");
        mkdirSync(scriptsDir, { recursive: true });
        const checkScriptPath = resolve(currentDir, "../scripts/check-app-config.sh");
        copyFileSync(checkScriptPath, join(scriptsDir, "check-app-config.sh"));

        copyFileSync(resolve(currentDir, "../src/server.ts"), join(servicesDir, "server.ts"));
        copyFileSync(appTomlPath, join(tempDir, "services/shopify/shopify.app.toml"));
        copyFileSync(unitPath, join(deployDir, "openrail-shopify.service"));
        copyFileSync(envPath, join(envDir, "shopify.env.example"));

        const packArchive = join(tempDir, "openrail-server-test.tar.gz");
        execFileSync("tar", [
          "-czf",
          packArchive,
          "-C",
          tempDir,
          "services",
          "deploy",
        ]);

        const listing = execFileSync("tar", ["-tzf", packArchive], { encoding: "utf8" });
        expect(listing).toContain("services/shopify/src/server.ts");
        expect(listing).toContain("services/shopify/shopify.app.toml");
        expect(listing).toContain("services/shopify/scripts/check-app-config.sh");
        expect(listing).toContain("deploy/systemd/openrail-shopify.service");
        expect(listing).toContain("deploy/env/shopify.env.example");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("shopify_deploy_check_refuses_placeholder_client_id", () => {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const checkScript = resolve(currentDir, "../scripts/check-app-config.sh");
      expect(existsSync(checkScript)).toBe(true);

      const appTomlPath = resolve(currentDir, "../shopify.app.toml");
      expect(existsSync(appTomlPath)).toBe(true);

      // 1. Refuses current placeholder in shopify.app.toml (${SHOPIFY_CLIENT_ID})
      let failed = false;
      try {
        execFileSync("bash", [checkScript, appTomlPath], { stdio: "pipe" });
      } catch (err: any) {
        failed = true;
        const stderr = err.stderr ? err.stderr.toString("utf8") : "";
        expect(stderr).toContain("placeholder");
        expect(stderr).toContain("Shopify CLI does NOT expand environment variables");
      }
      expect(failed).toBe(true);

      // 2. Refuses placeholder forms like <YOUR_CLIENT_ID> or empty
      const tempDir = mkdtempSync(join(tmpdir(), "shopify-config-check-"));
      try {
        const angleBracketFile = join(tempDir, "angle.toml");
        writeFileSync(angleBracketFile, 'client_id = "<YOUR_CLIENT_ID>"\n');
        let angleFailed = false;
        try {
          execFileSync("bash", [checkScript, angleBracketFile], { stdio: "pipe" });
        } catch (err: any) {
          angleFailed = true;
          const stderr = err.stderr?.toString("utf8") ?? "";
          expect(stderr).toContain("placeholder");
        }
        expect(angleFailed).toBe(true);

        const emptyFile = join(tempDir, "empty.toml");
        writeFileSync(emptyFile, 'client_id = ""\n');
        let emptyFailed = false;
        try {
          execFileSync("bash", [checkScript, emptyFile], { stdio: "pipe" });
        } catch (err: any) {
          emptyFailed = true;
          const stderr = err.stderr?.toString("utf8") ?? "";
          expect(stderr).toContain("empty");
        }
        expect(emptyFailed).toBe(true);

        // 3. Accepts valid Client ID
        const validFile = join(tempDir, "valid.toml");
        writeFileSync(validFile, 'client_id = "0193248a7b9c4f"\n');
        const out = execFileSync("bash", [checkScript, validFile], { encoding: "utf8" });
        expect(out).toContain("OK: client_id is configured (0193248a7b9c4f)");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});



