import AxeBuilder from "@axe-core/playwright";
import { pickRoute } from "./helpers";
import { expect, test, type Page, type Route as PwRoute } from "@playwright/test";
import { readFileSync } from "node:fs";

const API = "http://127.0.0.1:8787";
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../fixtures/api/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const CORS = {
  "access-control-allow-origin": "http://127.0.0.1:3100",
  "access-control-allow-credentials": "true",
  "access-control-allow-headers": "authorization,content-type,idempotency-key",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

const ETH_ROUTE = {
  id: "R10",
  origin_chain: "base",
  payer_asset: "ETH",
  origin_asset_id: "nep141:eth.omft.near",
  origin_decimals: 18,
  origin_contract: null,
  swap_type: "EXACT_OUTPUT",
  destination_asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  evm_chain_id: 8453,
  rpc_var: "BASE_RPC_URL",
  part_b: true,
};

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const REFUND = "0x53C5D39A5828BaDf817E40f22d75d96D731f8239";

interface Setup {
  checkout?: Record<string, any> | (() => Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any
  checkoutStatus?: number;
  sessions?: Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  statuses?: Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function mockCheckout(page: Page, s: Setup = {}) {
  const routes = [...fixture("pay.claims.get").routes, ETH_ROUTE];
  const expiresAt = inMinutes(15);
  const requestedUnix = Math.floor(Date.parse(expiresAt) / 1000);
  const checkout =
    typeof s.checkout === "function"
      ? s.checkout()
      : (s.checkout ?? {
          id: "c-101",
          token_id: "c-101",
          claim_account: "c-101.claims.openrail.near",
          merchant: "acme.openrail.near",
          order_ref: "ORD-42",
          amount_usd: "2.00",
          amount_due: "2000000",
          outstanding: "2000000",
          paid_total: "0",
          surplus: "0",
          status: "pending",
          expires_at: expiresAt,
          return_url: "https://shop.example/thanks?order=ORD-42",
          routes,
          sessions: [],
        });
  const sessions = s.sessions ?? [
    {
      ...fixture("pay.sessions.create"),
      token_id: "c-101",
      amount_usd: "2.00",
      amount_in: "2000000",
      amount_out: "2000000",
      deadline_requested: requestedUnix,
      // Provider deadline is 3 days out; the page must count down to `deadline_requested`.
      deadline: inMinutes(3 * 24 * 60),
    },
  ];
  const statuses = s.statuses ?? [{ ...fixture("pay.sessions.status"), status: "pending_deposit" }];
  const calls = { posts: [] as unknown[], polls: 0 };
  const json = (route: PwRoute, status: number, body: unknown) =>
    route.fulfill({
      status,
      headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (url.pathname.startsWith("/v1/public/checkouts/")) {
      const payload = typeof s.checkout === "function" ? s.checkout() : (s.checkout ?? checkout);
      return s.checkoutStatus && s.checkoutStatus !== 200
        ? json(route, s.checkoutStatus, { error: { code: "checkout_not_found" } })
        : json(route, 200, payload);
    }
    if (url.pathname === "/v1/pay/sessions" && req.method() === "POST") {
      calls.posts.push(req.postDataJSON());
      return json(route, 201, sessions[Math.min(calls.posts.length - 1, sessions.length - 1)]);
    }
    if (url.pathname.startsWith("/v1/pay/sessions/")) {
      const body = statuses[Math.min(calls.polls, statuses.length - 1)];
      calls.polls += 1;
      return json(route, 200, body);
    }
    return json(route, 404, { error: { code: "not_found", message: url.pathname } });
  });
  return calls;
}

async function pick(page: Page, name = "USDC on Base", refund = REFUND) {
  await pickRoute(page, name);
  await page.getByLabel("Refund address").fill(refund);
  await page.getByRole("button", { name: "Get price" }).click();
}

test("checkout page shows order ref, amount, route picker, quote, QR, countdown and return link", async ({
  page,
}) => {
  await mockCheckout(page);
  await page.goto("/c/c-101");
  await expect(page.getByText("Order ORD-42")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pay acme.openrail.near" })).toBeVisible();
  await expect(page.getByText("$2.00").first()).toBeVisible();
  const back = page.getByRole("link", { name: "Return to merchant" });
  await expect(back).toHaveAttribute("href", "https://shop.example/thanks?order=ORD-42");

  await pick(page);
  await expect(page.getByRole("region", { name: "Your price" })).toBeVisible();
  await expect(page.locator("svg title", { hasText: "Send to" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Copy address" })).toBeVisible();
});

test("checkout_no_quote_after_expiry: expired checkout shows plain notice and no quote form", async ({
  page,
}) => {
  const calls = await mockCheckout(page, {
    checkout: {
      id: "c-101",
      token_id: "c-101",
      claim_account: "c-101.claims.openrail.near",
      merchant: "acme.openrail.near",
      order_ref: "ORD-42",
      amount_usd: "2.00",
      amount_due: "2000000",
      outstanding: "2000000",
      paid_total: "0",
      surplus: "0",
      status: "expired",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      return_url: null,
      routes: fixture("pay.claims.get").routes,
      sessions: [],
    },
  });
  await page.goto("/c/c-101");
  await expect(page.getByText("This checkout has expired")).toBeVisible();
  await expect(page.getByText("No new price can be created for an expired checkout")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Pay with/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Get price" })).toHaveCount(0);
  expect(calls.posts).toHaveLength(0);
});

test("pos_shows_settling_on_origin_seen, then paid", async ({ page }) => {
  await mockCheckout(page, {
    statuses: [
      {
        ...fixture("pay.sessions.status"),
        status: "processing",
        swap_details: {
          status: "PROCESSING",
          origin_chain_tx_hashes: ["0xabc"],
          near_tx_hashes: [],
        },
      },
      {
        ...fixture("pay.sessions.status"),
        status: "success",
        swap_details: {
          status: "SUCCESS",
          origin_chain_tx_hashes: ["0xabc"],
          near_tx_hashes: ["near1"],
        },
      },
    ],
  });
  await page.goto("/c/c-101");
  await pick(page);
  await expect(page.getByText("Payment received, settling").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
});

test("partial, late, not found and error states", async ({ page }) => {
  await mockCheckout(page, {
    checkout: {
      id: "c-101",
      token_id: "c-101",
      claim_account: "c-101.claims.openrail.near",
      merchant: "acme.openrail.near",
      order_ref: "ORD-42",
      amount_usd: "2.00",
      amount_due: "2000000",
      outstanding: "1000000",
      paid_total: "1000000",
      surplus: "0",
      status: "partial",
      expires_at: inMinutes(10),
      return_url: null,
      routes: fixture("pay.claims.get").routes,
      sessions: [],
    },
  });
  await page.goto("/c/c-101");
  await expect(page.getByText("Partially paid · $1.00 still due")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Pay with/ })).toBeVisible();

  const latePage = await page.context().newPage();
  await mockCheckout(latePage, {
    checkout: {
      id: "c-102",
      token_id: "c-102",
      claim_account: "c-102.claims.openrail.near",
      merchant: "acme.openrail.near",
      order_ref: "ORD-43",
      amount_usd: "2.00",
      amount_due: "2000000",
      outstanding: "0",
      paid_total: "2000000",
      surplus: "0",
      status: "late",
      expires_at: new Date(Date.now() - 180_000).toISOString(),
      return_url: null,
      routes: fixture("pay.claims.get").routes,
      sessions: [],
    },
  });
  await latePage.goto("/c/c-102");
  await expect(latePage.getByText("Paid after expiry").first()).toBeVisible();
  await expect(latePage.getByRole("button", { name: "Get price" })).toHaveCount(0);

  const missing = await page.context().newPage();
  await mockCheckout(missing, { checkoutStatus: 404 });
  await missing.goto("/c/c-none");
  await expect(missing.getByRole("heading", { name: "We can't find this checkout" })).toBeVisible();

  const broken = await page.context().newPage();
  await mockCheckout(broken, { checkoutStatus: 500 });
  await broken.goto("/c/c-err");
  await expect(broken.locator("main [role=alert]")).toBeVisible();
  await expect(broken.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("late-then-refunded-again lifecycle: transitions across late, refunded, second late arrival, and second refund", async ({
  page,
}) => {
  let state = "late";
  const routes = fixture("pay.claims.get").routes;
  const lateCheckout = (status: string, paid: string) => ({
    id: "c-103",
    token_id: "c-103",
    claim_account: "c-103.claims.openrail.near",
    merchant: "acme.openrail.near",
    order_ref: "ORD-99",
    amount_usd: "2.00",
    amount_due: "2000000",
    outstanding: paid === "2000000" ? "0" : "1000000",
    paid_total: paid,
    surplus: "0",
    status,
    expires_at: new Date(Date.now() - 300_000).toISOString(),
    return_url: null,
    routes,
    sessions: [],
  });

  await mockCheckout(page, {
    checkout: () => {
      switch (state) {
        case "late":
          return lateCheckout("late", "1000000");
        case "refunded":
          return lateCheckout("refunded", "1000000");
        case "late_again":
          return lateCheckout("late", "2000000");
        case "refunded_again":
          return lateCheckout("refunded", "2000000");
        default:
          return lateCheckout("late", "1000000");
      }
    },
  });

  await page.goto("/c/c-103");
  // 1. Initial late state: banner shows "Paid after expiry" and quote form is omitted
  await expect(page.getByText("Paid after expiry").first()).toBeVisible();
  await expect(page.getByText("Your payment arrived after the order expired")).toBeVisible();
  await expect(page.getByRole("button", { name: "Get price" })).toHaveCount(0);

  // 2. Merchant refunds late payment 1 -> live poll updates status to "refunded"
  state = "refunded";
  await expect(page.getByText("Refunded", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText("This late payment is being returned to the refund address you gave."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Get price" })).toHaveCount(0);

  // 3. Second late arrival lands on chain and is held -> live poll updates status back to "late"
  state = "late_again";
  await expect(page.getByText("Paid after expiry").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Get price" })).toHaveCount(0);

  // 4. Merchant refunds second late payment -> live poll updates status back to "refunded"
  state = "refunded_again";
  await expect(page.getByText("Refunded", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Get price" })).toHaveCount(0);
});

test("older invoice pay link /c/c-1 redirects to /pay/c-1", async ({ page }) => {
  await page.goto("/c/c-1");
  await expect(page).toHaveURL(/\/pay\/c-1$/);
});

test("checkout page supports opaque token ids (<username>-<hash>.openrail.near)", async ({
  page,
}) => {
  const opaqueId = "alice-9f3c2a7d41b8.openrail.near";
  await mockCheckout(page, {
    checkout: {
      id: opaqueId,
      token_id: opaqueId,
      claim_account: `${opaqueId}.claims.openrail.near`,
      merchant: "alice.openrail.near",
      order_ref: "ORD-OPAQUE-1",
      amount_usd: "5.00",
      amount_due: "5000000",
      outstanding: "5000000",
      paid_total: "0",
      surplus: "0",
      status: "pending",
      expires_at: inMinutes(15),
      return_url: null,
      server_time: new Date().toISOString(),
      routes: fixture("pay.claims.get").routes,
      sessions: [],
    },
  });
  await page.goto(`/c/${encodeURIComponent(opaqueId)}`);
  await expect(page.getByRole("heading", { name: "Pay alice.openrail.near" })).toBeVisible();
  await expect(page.getByText("$5.00").first()).toBeVisible();
  await expect(page.getByText("ORD-OPAQUE-1", { exact: true })).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`checkout page at 360px, ${scheme}: no horizontal scroll, no WCAG AA violations`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await mockCheckout(page);
    await page.goto("/c/c-101");
    await pick(page);
    await expect(page.getByRole("region", { name: "Your price" })).toBeVisible();
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const r = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(r.violations).toEqual([]);
  });
}
