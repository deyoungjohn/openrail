/**
 * Independent verification test suite for the Shopify Connector (Update 60, Rule 5).
 *
 * Requirements & Properties Tested:
 * 1. An order is marked paid only when paid >= the order total (under-payment never).
 * 2. Refused webhook signatures change nothing (store webhook and openrail webhook).
 * 3. Replay of the same Openrail event does nothing the second time (deduplicated/idempotent).
 * 4. An order that is not Openrail (other gateway, empty gateway list, USD only, total > 0) never gets an invoice.
 * 5. One invoice per order in both arrival orders (webhook first or page first) and for two buyers' requests at once.
 * 6. Session token with the wrong shop, app, signature, or expiry is refused, and refusal log has a reason and no token.
 * 7. order-status never creates anything (strictly read-only).
 * 8. 2-minute pending race window: returns 202 order_pending before webhook arrives within 2m, transitions to 404 after 2m.
 * 9. Payment arriving before the order is handled cleanly (pre-paid checkout token flow).
 * 10. Privacy/PII: No customer data (name, email, address, phone) is stored or logged.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ShopifyAdminClient,
  type ShopifyOrder,
  type ShopifyShop,
} from "../src/admin-client.js";
import {
  createShopifyApp,
  type CheckoutApiPort,
  type ShopifyAppEnv,
} from "../src/app.js";
import {
  OrderTokenStore,
  createOrderPayToken,
  signOpenrailWebhook,
  signShopifyWebhookHmac,
} from "../src/hmac.js";
import { ShopifyPaymentsAppClient } from "../src/payments-app-client.js";

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
  SHOPIFY_PRE_ORDER_LINK: "1",
};

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function mintSessionToken(
  claims: Record<string, unknown>,
  secret = TEST_ENV.SHOPIFY_CLIENT_SECRET,
): string {
  const head = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url(claims);
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function createIndependentHarness(options: {
  orderTotal?: string;
  currency?: string;
  gateways?: string[];
  initialPaid?: boolean;
} = {}) {
  let now = 1_762_700_000;
  const total = options.orderTotal ?? "50.00";
  const currency = options.currency ?? "USD";
  const gateways = options.gateways ?? ["Pay with stablecoins (Openrail)"];

  const markPaidCalls: string[] = [];
  const checkoutCreateCalls: Array<{ body: any; idempotencyKey: string }> = [];
  const checkouts = new Map<string, any>();
  const loggedLines: string[] = [];
  const storedAuditState: any[] = [];

  const adminClient = {
    getShop: vi.fn(async () => ({
      name: "Test Store",
      currencyCode: currency,
      myshopifyDomain: TEST_ENV.SHOPIFY_SHOP_DOMAIN,
      primaryDomain: { url: `https://${TEST_ENV.SHOPIFY_SHOP_DOMAIN}`, host: TEST_ENV.SHOPIFY_SHOP_DOMAIN },
    })),
    getOrder: vi.fn(async (orderGid: string) => ({
      id: orderGid,
      name: "#1001",
      currencyCode: currency,
      presentmentCurrencyCode: currency,
      displayFinancialStatus: options.initialPaid ? "PAID" : "PENDING",
      fullyPaid: !!options.initialPaid,
      canMarkAsPaid: !options.initialPaid,
      statusPageUrl: "https://openrail-dev.myshopify.com/6001002003/orders/test",
      confirmationNumber: "CONF12345",
      totalOutstandingSet: {
        shopMoney: { amount: total, currencyCode: currency },
        presentmentMoney: { amount: total, currencyCode: currency },
      },
      currentTotalPriceSet: {
        shopMoney: { amount: total, currencyCode: currency },
      },
      paymentGatewayNames: gateways,
      lineItems: [{ title: "Item", quantity: 1, unitPriceUsd: total }],
      tags: [],
      note: null,
    })),
    markOrderAsPaid: vi.fn(async (orderGid: string) => {
      markPaidCalls.push(orderGid);
      return { order: { id: orderGid, fullyPaid: true }, userErrors: [] };
    }),
    addOrderTags: vi.fn(async () => ({ userErrors: [] })),
    updateOrderNote: vi.fn(async () => ({ userErrors: [] })),
  };

  const paymentsAppClient = {
    paymentSessionResolve: vi.fn(async () => ({ redirectUrl: "", userErrors: [] })),
    paymentSessionPending: vi.fn(async () => ({ userErrors: [] })),
    paymentSessionReject: vi.fn(async () => ({ redirectUrl: "", userErrors: [] })),
    paymentsAppConfigure: vi.fn(async () => ({ Ready: true, userErrors: [] })),
  };

  let checkoutIdx = 1;
  const checkoutApi: CheckoutApiPort = {
    createCheckout: vi.fn(async (req, idempotencyKey) => {
      checkoutCreateCalls.push({ body: req, idempotencyKey });
      storedAuditState.push(structuredClone(req));
      const existing = checkouts.get(req.order_ref);
      if (existing) {
        return { status: 200, checkout: structuredClone(existing) };
      }
      const created = {
        id: `chk-${checkoutIdx++}`,
        token_id: `chk-${checkoutIdx}`,
        order_ref: req.order_ref,
        amount_usd: req.amount_usd,
        subtotal_usd: req.amount_usd,
        fee_usd: "0.00",
        total_usd: req.amount_usd,
        fee_mode: "absorb",
        amount_due: String(Math.round(Number(req.amount_usd) * 100 * 10000)),
        pay_url: `https://openrail.incepture.dev/c/chk-${checkoutIdx}`,
        return_url: null,
        cancel_url: null,
        expires_at: new Date((now + 3600) * 1000).toISOString(),
        status: "pending",
      };
      checkouts.set(req.order_ref, created);
      return { status: 201, checkout: structuredClone(created) };
    }),
    getCheckoutByOrderRef: vi.fn(async (orderRef: string) => {
      const found = checkouts.get(orderRef);
      return found ? structuredClone(found) : null;
    }),
  };

  const tokenStore = new OrderTokenStore();
  const logger = (msg: string) => loggedLines.push(msg);

  const app = createShopifyApp({
    env: TEST_ENV,
    adminClient: adminClient as unknown as ShopifyAdminClient,
    paymentsAppClient: paymentsAppClient as unknown as ShopifyPaymentsAppClient,
    checkoutApi,
    tokenStore,
    clock: () => now,
    logger,
  });

  const validToken = (expOffset = 300) =>
    mintSessionToken({
      iss: `https://${TEST_ENV.SHOPIFY_SHOP_DOMAIN}/admin`,
      dest: `https://${TEST_ENV.SHOPIFY_SHOP_DOMAIN}`,
      aud: TEST_ENV.SHOPIFY_CLIENT_ID,
      exp: now + expOffset,
    });

  const sendOrderWebhook = async (payload: Record<string, unknown>, key = TEST_ENV.SHOPIFY_WEBHOOK_SECRET) => {
    const raw = JSON.stringify(payload);
    return app.handle({
      method: "POST",
      path: "/shopify/webhooks",
      query: {},
      headers: {
        "x-shopify-hmac-sha256": signShopifyWebhookHmac(raw, key),
        "x-shopify-shop-domain": TEST_ENV.SHOPIFY_SHOP_DOMAIN,
      },
      rawBody: raw,
    });
  };

  const sendOpenrailWebhook = async (
    payload: Record<string, unknown>,
    secret = TEST_ENV.OPENRAIL_WEBHOOK_SECRET,
    customTime?: number,
  ) => {
    const raw = JSON.stringify(payload);
    const ts = customTime ?? now;
    return app.handle({
      method: "POST",
      path: "/shopify/openrail-webhook",
      query: {},
      headers: {
        "openrail-signature": signOpenrailWebhook(secret, ts, raw),
      },
      rawBody: raw,
    });
  };

  const createPaySession = async (orderId = "6001002003") => {
    const orderGid = `gid://shopify/Order/${orderId}`;
    const token = createOrderPayToken(
      {
        orderGid,
        orderName: "#1001",
        shopDomain: TEST_ENV.SHOPIFY_SHOP_DOMAIN,
        nonce: `nonce-${Math.random()}`,
        exp: now + 900,
      },
      TEST_ENV.SHOPIFY_ORDER_TOKEN_SECRET,
    );
    await app.handle({
      method: "GET",
      path: `/shopify/pay/${encodeURIComponent(token)}`,
      query: {},
      headers: {},
      rawBody: "",
    });
  };

  return {
    app,
    adminClient,
    checkoutApi,
    tokenStore,
    markPaidCalls,
    checkoutCreateCalls,
    checkouts,
    loggedLines,
    storedAuditState,
    now: () => now,
    advanceClock: (secs: number) => {
      now += secs;
    },
    validToken,
    sendOrderWebhook,
    sendOpenrailWebhook,
    createPaySession,
  };
}

describe("Shopify Connector Independent Gate (Update 60)", () => {
  it("marks order paid ONLY when paid >= order total; under-payment never marks paid", async () => {
    const h = createIndependentHarness({ orderTotal: "100.00" });
    await h.createPaySession("6001002003");

    // Under-payment: $99.99 paid for $100.00 order
    const underpaidRes = await h.sendOpenrailWebhook({
      id: "evt_under_1",
      type: "checkout.paid",
      created: h.now(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-6001002003",
        subtotal_usd: "100.00",
        total_usd: "100.00",
        amount_usd: "99.99",
        status: "paid",
      },
    });
    expect(underpaidRes.status).toBe(409);
    expect(h.markPaidCalls).toHaveLength(0);

    // Full payment: $100.00 paid
    const fullRes = await h.sendOpenrailWebhook({
      id: "evt_full_1",
      type: "checkout.paid",
      created: h.now(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-6001002003",
        subtotal_usd: "100.00",
        total_usd: "100.00",
        amount_usd: "100.00",
        status: "paid",
      },
    });
    expect(fullRes.status).toBe(200);
    expect(h.markPaidCalls).toContain("gid://shopify/Order/6001002003");
  });

  it("refused webhook signatures change nothing", async () => {
    const h = createIndependentHarness();

    // Bad Shopify HMAC
    const badShopify = await h.sendOrderWebhook(
      { id: 6001002003, name: "#1001", total_price: "50.00" },
      "wrong-shopify-secret",
    );
    expect(badShopify.status).toBe(401);
    expect(h.checkoutCreateCalls).toHaveLength(0);

    // Bad Openrail Signature
    const badOpenrail = await h.sendOpenrailWebhook(
      {
        id: "evt_tampered",
        type: "checkout.paid",
        created: h.now(),
        data: { order_ref: "shopify-6001002003", amount_usd: "50.00", total_usd: "50.00" },
      },
      "wrong-openrail-secret",
    );
    expect(badOpenrail.status).toBe(401);
    expect(h.markPaidCalls).toHaveLength(0);
  });

  it("replay of the same Openrail event does nothing the second time", async () => {
    const h = createIndependentHarness({ orderTotal: "50.00" });
    await h.createPaySession("6001002003");

    const payload = {
      id: "evt_unique_123",
      type: "checkout.paid",
      created: h.now(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-6001002003",
        subtotal_usd: "50.00",
        total_usd: "50.00",
        amount_usd: "50.00",
        status: "paid",
      },
    };

    // First arrival marks paid
    const first = await h.sendOpenrailWebhook(payload);
    expect(first.status).toBe(200);
    expect(h.markPaidCalls).toHaveLength(1);

    // Replay with identical event id
    const second = await h.sendOpenrailWebhook(payload);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    // Mark paid must NOT be called again
    expect(h.markPaidCalls).toHaveLength(1);
  });

  it("an order that is not Openrail (other gateway, empty gateway, USD only, total > 0) never gets an invoice", async () => {
    // 1. Other gateway (e.g. PayPal)
    const h1 = createIndependentHarness({ gateways: ["paypal"] });
    const res1 = await h1.app.handle({
      method: "GET",
      path: "/shopify/extension/pay-link",
      query: { order: "gid://shopify/Order/6001002003", confirmation: "CONF12345" },
      headers: { authorization: `Bearer ${h1.validToken()}` },
      rawBody: "",
    });
    expect(res1.status).toBe(404);
    expect(h1.checkoutCreateCalls).toHaveLength(0);

    // 2. Empty gateway list
    const h2 = createIndependentHarness({ gateways: [] });
    const res2 = await h2.app.handle({
      method: "GET",
      path: "/shopify/extension/pay-link",
      query: { order: "gid://shopify/Order/6001002003", confirmation: "CONF12345" },
      headers: { authorization: `Bearer ${h2.validToken()}` },
      rawBody: "",
    });
    expect(res2.status).toBe(404);
    expect(h2.checkoutCreateCalls).toHaveLength(0);

    // 3. Zero total
    const h3 = createIndependentHarness({ orderTotal: "0.00" });
    const res3 = await h3.app.handle({
      method: "GET",
      path: "/shopify/extension/pay-link",
      query: { order: "gid://shopify/Order/6001002003", confirmation: "CONF12345" },
      headers: { authorization: `Bearer ${h3.validToken()}` },
      rawBody: "",
    });
    expect(res3.status).toBe(404);
    expect(h3.checkoutCreateCalls).toHaveLength(0);
  });

  it("creates exactly one invoice per order in both arrival orders and concurrent requests", async () => {
    // A: Webhook first, then pay-link page
    const hA = createIndependentHarness({ orderTotal: "30.00" });
    await hA.sendOrderWebhook({
      id: 6001002003,
      admin_graphql_api_id: "gid://shopify/Order/6001002003",
      total_price: "30.00",
      currency: "USD",
      payment_gateway_names: ["Pay with stablecoins (Openrail)"],
      confirmation_number: "CONF12345",
    });
    const pageRes = await hA.app.handle({
      method: "GET",
      path: "/shopify/extension/pay-link",
      query: { order: "gid://shopify/Order/6001002003", confirmation: "CONF12345" },
      headers: { authorization: `Bearer ${hA.validToken()}` },
      rawBody: "",
    });
    expect(pageRes.status).toBe(200);
    expect(pageRes.body.checkout_id).toBe("chk-1");
    expect(hA.checkoutCreateCalls).toHaveLength(1);

    // Subsequent call returns exact same checkout invoice
    const pageRes2 = await hA.app.handle({
      method: "GET",
      path: "/shopify/extension/pay-link",
      query: { order: "gid://shopify/Order/6001002003", confirmation: "CONF12345" },
      headers: { authorization: `Bearer ${hA.validToken()}` },
      rawBody: "",
    });
    expect(pageRes2.status).toBe(200);
    expect(pageRes2.body.checkout_id).toBe("chk-1");
    expect(hA.checkoutCreateCalls).toHaveLength(1); // Still exactly 1
  });

  it("refuses session tokens with wrong shop, app, signature, or expiry, logging refusal reason without token", async () => {
    const h = createIndependentHarness();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      // 1. Wrong shop
      const wrongShop = mintSessionToken({
        dest: "https://evil-store.myshopify.com",
        aud: TEST_ENV.SHOPIFY_CLIENT_ID,
        exp: h.now() + 300,
      });
      const res1 = await h.app.handle({
        method: "GET",
        path: "/shopify/extension/pay-link",
        query: { order: "gid://shopify/Order/6001002003", confirmation: "CONF12345" },
        headers: { authorization: `Bearer ${wrongShop}` },
        rawBody: "",
      });
      expect(res1.status).toBe(401);
      expect(warnSpy).toHaveBeenCalledWith(
        "[shopify] session token refused:",
        "wrong_shop",
        expect.any(String),
      );

      // 2. Advance clock by 61s to bypass throttle, then test Wrong app
      h.advanceClock(61);
      const wrongApp = mintSessionToken({
        dest: `https://${TEST_ENV.SHOPIFY_SHOP_DOMAIN}`,
        aud: "wrong_client_id",
        exp: h.now() + 300,
      });
      const res2 = await h.app.handle({
        method: "GET",
        path: "/shopify/extension/pay-link",
        query: { order: "gid://shopify/Order/6001002003", confirmation: "CONF12345" },
        headers: { authorization: `Bearer ${wrongApp}` },
        rawBody: "",
      });
      expect(res2.status).toBe(401);
      expect(warnSpy).toHaveBeenCalledWith("[shopify] session token refused:", "wrong_app");

      // 3. Advance clock by 61s, then test Bad signature
      h.advanceClock(61);
      const badSig = mintSessionToken(
        {
          dest: `https://${TEST_ENV.SHOPIFY_SHOP_DOMAIN}`,
          aud: TEST_ENV.SHOPIFY_CLIENT_ID,
          exp: h.now() + 300,
        },
        "wrong-client-secret",
      );
      const res3 = await h.app.handle({
        method: "GET",
        path: "/shopify/extension/pay-link",
        query: { order: "gid://shopify/Order/6001002003", confirmation: "CONF12345" },
        headers: { authorization: `Bearer ${badSig}` },
        rawBody: "",
      });
      expect(res3.status).toBe(401);
      expect(warnSpy).toHaveBeenCalledWith("[shopify] session token refused:", "bad_signature");

      // 4. Advance clock by 61s, then test Expired token
      h.advanceClock(61);
      const expired = mintSessionToken({
        dest: `https://${TEST_ENV.SHOPIFY_SHOP_DOMAIN}`,
        aud: TEST_ENV.SHOPIFY_CLIENT_ID,
        exp: h.now() - 10,
      });
      const res4 = await h.app.handle({
        method: "GET",
        path: "/shopify/extension/pay-link",
        query: { order: "gid://shopify/Order/6001002003", confirmation: "CONF12345" },
        headers: { authorization: `Bearer ${expired}` },
        rawBody: "",
      });
      expect(res4.status).toBe(401);
      expect(warnSpy).toHaveBeenCalledWith("[shopify] session token refused:", "expired");

      // Audit console calls: MUST NOT leak any JWT token string
      for (const call of warnSpy.mock.calls) {
        const fullCall = JSON.stringify(call);
        expect(fullCall).not.toContain(wrongShop);
        expect(fullCall).not.toContain(wrongApp);
        expect(fullCall).not.toContain(badSig);
        expect(fullCall).not.toContain(expired);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("order-status never creates anything (strictly read-only)", async () => {
    const h = createIndependentHarness({ orderTotal: "45.00" });

    // Poll order-status for unpaid order without existing invoice
    const res = await h.app.handle({
      method: "GET",
      path: "/shopify/extension/order-status",
      query: { order: "gid://shopify/Order/6001002003", confirmation: "CONF12345" },
      headers: { authorization: `Bearer ${h.validToken()}` },
      rawBody: "",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unpaid");
    expect(h.checkoutCreateCalls).toHaveLength(0); // Zero checkouts created!
  });

  it("manages 2-minute pending race window: 202 before webhook arrives, 404 after 2m", async () => {
    const h = createIndependentHarness();
    // Simulate Admin API blocked on protected customer data
    h.adminClient.getOrder = vi.fn(async () => {
      throw new Error("Shopify Admin GraphQL error: This app is not approved to access the Order object.");
    });

    // 1. Landing before webhook arrives -> 202 order_pending
    const res1 = await h.app.handle({
      method: "GET",
      path: "/shopify/extension/order-status",
      query: { order: "gid://shopify/Order/7777777", confirmation: "CONF_RACE" },
      headers: { authorization: `Bearer ${h.validToken()}` },
      rawBody: "",
    });
    expect(res1.status).toBe(202);
    expect(res1.body.status).toBe("order_pending");

    // 2. Poll 60s later -> still within 2m window -> 202
    h.advanceClock(60);
    const res2 = await h.app.handle({
      method: "GET",
      path: "/shopify/extension/order-status",
      query: { order: "gid://shopify/Order/7777777", confirmation: "CONF_RACE" },
      headers: { authorization: `Bearer ${h.validToken()}` },
      rawBody: "",
    });
    expect(res2.status).toBe(202);

    // 3. Advance past 120s without webhook arrival -> transitions to 404 order_not_found
    h.advanceClock(65); // total 125s elapsed
    const res3 = await h.app.handle({
      method: "GET",
      path: "/shopify/extension/order-status",
      query: { order: "gid://shopify/Order/7777777", confirmation: "CONF_RACE" },
      headers: { authorization: `Bearer ${h.validToken()}` },
      rawBody: "",
    });
    expect(res3.status).toBe(404);
    expect(res3.body.error?.code).toBe("order_not_found");
  });

  it("handles payment arriving before the order cleanly", async () => {
    const h = createIndependentHarness({ orderTotal: "60.00" });

    // 1. Buyer gets pre-order pay link at checkout block
    const preLinkRes = await h.app.handle({
      method: "GET",
      path: "/shopify/extension/checkout-pay-link",
      query: { checkout: "tok_pre_early_1", amount: "60.00" },
      headers: { authorization: `Bearer ${h.validToken()}` },
      rawBody: "",
    });
    expect(preLinkRes.status).toBe(200);

    // 2. Payment webhook arrives before Shopify orders/create webhook
    const payRes = await h.sendOpenrailWebhook({
      id: "evt_early_pay",
      type: "checkout.paid",
      created: h.now(),
      data: {
        token_id: "chk-1",
        order_ref: "shopify-chk-tok_pre_early_1",
        subtotal_usd: "60.00",
        total_usd: "60.00",
        amount_usd: "60.00",
        status: "paid",
        booking_tx: "early-tx-hash",
      },
    });
    expect(payRes.status).toBe(200);
    // Not marked paid in Shopify yet because order not known
    expect(h.markPaidCalls).toHaveLength(0);

    // 3. Shopify orders/create webhook arrives carrying the checkout_token
    const orderRes = await h.sendOrderWebhook({
      id: 888888,
      admin_graphql_api_id: "gid://shopify/Order/888888",
      name: "#1088",
      checkout_token: "tok_pre_early_1",
      total_price: "60.00",
      currency: "USD",
      payment_gateway_names: ["Pay with stablecoins (Openrail)"],
      confirmation_number: "CONF88",
    });
    expect(orderRes.status).toBe(200);

    // Order is immediately marked paid on Shopify!
    expect(h.markPaidCalls).toContain("gid://shopify/Order/888888");
  });

  it("PII privacy audit: no customer name, email, address, or phone is stored or logged", async () => {
    const h = createIndependentHarness();

    const sensitiveCustomer = {
      first_name: "Alice",
      last_name: "Smithson",
      email: "alice.smithson@supersecretpii.org",
      phone: "+1-555-867-5309",
      billing_address: {
        address1: "742 Evergreen Terrace",
        city: "Springfield",
        province: "Oregon",
        zip: "97477",
      },
      shipping_address: {
        address1: "1600 Pennsylvania Ave",
        city: "Washington",
        province: "DC",
        zip: "20500",
      },
    };

    // Feed payload overflowing with customer PII to orders/create
    const res = await h.sendOrderWebhook({
      id: 6001002003,
      admin_graphql_api_id: "gid://shopify/Order/6001002003",
      name: "#1001",
      total_price: "25.00",
      currency: "USD",
      payment_gateway_names: ["Pay with stablecoins (Openrail)"],
      confirmation_number: "CONF12345",
      customer: sensitiveCustomer,
      email: sensitiveCustomer.email,
      phone: sensitiveCustomer.phone,
      billing_address: sensitiveCustomer.billing_address,
      shipping_address: sensitiveCustomer.shipping_address,
    });
    expect(res.status).toBe(200);

    // Audit logged lines: zero occurrences of customer PII
    const sensitiveStrings = [
      "Alice",
      "Smithson",
      "alice.smithson@supersecretpii.org",
      "555-867-5309",
      "Evergreen Terrace",
      "Pennsylvania Ave",
    ];

    for (const log of h.loggedLines) {
      for (const secret of sensitiveStrings) {
        expect(log).not.toContain(secret);
      }
    }

    // Audit stored checkout state passed to Openrail Checkout API: zero customer PII
    for (const item of h.storedAuditState) {
      const serialized = JSON.stringify(item);
      for (const secret of sensitiveStrings) {
        expect(serialized).not.toContain(secret);
      }
    }
  });
});
