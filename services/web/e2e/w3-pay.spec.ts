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

/** Picks a chain, gives the refund address and asks for the price. */
async function pick(page: Page, name = "USDC on Base", refund = REFUND) {
  await pickRoute(page, name);
  await page.getByLabel("Refund address").fill(refund);
  await page.getByRole("button", { name: "Get price" }).click();
}

interface Setup {
  claim?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  claimStatus?: number;
  /** Responses of POST /v1/pay/sessions, in order; the last one repeats. */
  sessions?: Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Responses of GET /v1/pay/sessions/{id}, in order; the last one repeats. */
  statuses?: Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function mockApi(page: Page, s: Setup = {}) {
  const claim = s.claim ?? {
    ...fixture("pay.claims.get"),
    routes: [...fixture("pay.claims.get").routes, ETH_ROUTE],
  };
  const sessions = s.sessions ?? [{ ...fixture("pay.sessions.create"), deadline: inMinutes(10) }];
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
    if (url.pathname.startsWith("/v1/pay/claims/")) {
      return s.claimStatus && s.claimStatus !== 200
        ? json(route, s.claimStatus, { error: { code: "not_found", message: "no such invoice" } })
        : json(route, 200, claim);
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

test("shows who to pay, the amount and the chains to pay from", async ({ page }) => {
  await mockApi(page);
  await page.goto("/pay/c-1");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("INV-2026-001");
  await expect(main.getByText("Acme Ltd").first()).toBeVisible();
  await expect(main.getByText("$12.50").first()).toBeVisible();
  await expect(main.getByText("INV-2026-001").first()).toBeVisible();
  // The invoice's own details are on the page, then the two selects that choose how to pay.
  await expect(main.getByText("Northwind")).toHaveCount(0);
  await expect(main.getByText("Billed to")).toBeVisible();
  await expect(main.getByText("Terms fingerprint")).toBeVisible();
  await main.getByRole("button", { name: /^Pay with/ }).click();
  await expect(page.getByRole("option")).toHaveText(["USDC", "ETH"]);
  await page.getByRole("option", { name: "USDC", exact: true }).click();
  await main.getByRole("button", { name: /^Network/ }).click();
  await expect(page.getByRole("option")).toHaveText(["Base", "BNB Chain"]);
});

test("USDC route: exact amount, then the address, and the locked amount comes first", async ({
  page,
}) => {
  const calls = await mockApi(page);
  await page.goto("/pay/c-1");
  await pick(page);
  const quote = page.getByRole("region", { name: "Your price" });
  await expect(quote).toContainText("You send exactly");
  await expect(quote).toContainText("12.50 USDC");
  await expect(quote).toContainText("on Base");
  await expect(quote).toContainText("The invoice receives");
  await expect(quote).not.toContainText("Price protection margin");
  expect(calls.posts).toEqual([{ token_id: "c-1", route_id: "R1", refund_to: REFUND }]);

  const address = page.locator("code", { hasText: "0xeeeeee" });
  await expect(address).toBeVisible();
  const q = await quote.boundingBox();
  const a = await address.boundingBox();
  expect(q!.y).toBeLessThan(a!.y);
});

test("ETH route: 'you pay up to', every digit, and the margin explained", async ({ page }) => {
  await mockApi(page, {
    sessions: [
      {
        ...fixture("pay.sessions.create"),
        route_id: "R10",
        amount_in: "3812345678901234000",
        amount_out: "12500000",
        spread_bps: 30,
        deadline: inMinutes(10),
      },
    ],
  });
  await page.goto("/pay/c-1");
  await pick(page, "ETH on Base");
  const quote = page.getByRole("region", { name: "Your price" });
  await expect(quote).toContainText("You pay up to");
  // The amount is rounded up to what a wallet can enter (six decimals), never down, so it is never short.
  await expect(quote).toContainText("3.812346 ETH");
  await expect(quote).toContainText("0.30%");
  await expect(quote).toContainText("Price protection margin");
});

test("follows the payment to Paid and shows the proof", async ({ page }) => {
  await mockApi(page, {
    statuses: [
      { ...fixture("pay.sessions.status"), status: "processing" },
      { ...fixture("pay.sessions.status"), status: "success" },
    ],
  });
  await page.goto("/pay/c-1");
  await pick(page);
  await expect(page.getByText("Your payment arrived")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Proof" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Your transaction")).toBeVisible();
  await expect(page.getByText("Payout transaction").first()).toBeVisible();
});

test("an expired price is never reused: a new one is requested", async ({ page }) => {
  const calls = await mockApi(page, {
    sessions: [
      {
        ...fixture("pay.sessions.create"),
        id: "ps_old",
        deadline: new Date(Date.now() - 60_000).toISOString(),
      },
      { ...fixture("pay.sessions.create"), id: "ps_new", deadline: inMinutes(10) },
    ],
  });
  await page.goto("/pay/c-1");
  await pick(page);
  await expect(page.getByText("This price expired")).toBeVisible();
  await expect(page.getByRole("region", { name: "Your price" })).toHaveCount(0);
  await page.getByRole("button", { name: "Get a new price" }).click();
  await expect(page.getByRole("region", { name: "Your price" })).toBeVisible();
  expect(calls.posts).toHaveLength(2);
});

test("refunded and failed payments say what happens next", async ({ page }) => {
  await mockApi(page, { statuses: [{ ...fixture("pay.sessions.status"), status: "refunded" }] });
  await page.goto("/pay/c-1");
  await pick(page);
  await expect(page.getByText("Your payment is on its way back")).toBeVisible({ timeout: 15_000 });
});

test("paid, closed, not found and error states", async ({ page }) => {
  await mockApi(page, { claim: { ...fixture("pay.claims.get"), status: "Paid" } });
  await page.goto("/pay/c-1");
  await expect(page.getByText("already paid")).toBeVisible();
  await expect(page.getByRole("button", { name: /on Base/ })).toHaveCount(0);

  const p2 = await page.context().newPage();
  await mockApi(p2, { claimStatus: 404 });
  await p2.goto("/pay/c-x");
  await expect(p2.getByRole("heading", { name: "We can't find this invoice" })).toBeVisible();

  const p3 = await page.context().newPage();
  await mockApi(p3, { claimStatus: 500 });
  await p3.goto("/pay/c-x");
  await expect(p3.locator("main [role=alert]")).toBeVisible();
  await expect(p3.getByRole("button", { name: "Try again" })).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`pay page at 360px, ${scheme}: no scroll, no WCAG AA violations`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await mockApi(page);
    await page.goto("/pay/c-1");
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

// Run with SCREENSHOTS=1 to write the PR images to .next/e2e-screenshots/.
for (const scheme of ["light", "dark"] as const) {
  for (const width of [360, 1280]) {
    test(`screenshot pay ${scheme} ${width}`, async ({ page }) => {
      test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1");
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page);
      await page.goto("/pay/c-1");
      await pick(page);
      await expect(page.getByRole("region", { name: "Your price" })).toBeVisible();
      await page.waitForTimeout(800);
      await page.screenshot({
        path: `.next/e2e-screenshots/pay-${scheme}-${width}.png`,
        fullPage: true,
      });
    });
  }
}

test("the refund address is checked before any price is requested", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/pay/c-1");
  await pickRoute(page, "USDC on Base");
  await page.getByLabel("Refund address").fill("0x123");
  await page.getByRole("button", { name: "Get price" }).click();
  await expect(page.getByText("starts with 0x")).toBeVisible();
  expect(calls.posts).toHaveLength(0);
});

test("a connected wallet fills in the refund address", async ({ page }) => {
  await page.addInitScript((account) => {
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: async ({ method }: { method: string }) =>
        method === "eth_accounts" || method === "eth_requestAccounts" ? [account] : null,
      on: () => {},
      removeListener: () => {},
    };
  }, REFUND);
  await mockApi(page);
  await page.goto("/pay/c-1");
  // The wallet tab fills the address in; the first tab (pay from any wallet) never does.
  await page.getByRole("tab", { name: "Pay with your wallet" }).click();
  await pickRoute(page, "USDC on Base");
  await expect(page.getByLabel("Refund address")).toHaveValue(REFUND);
});

test("one centered column on a desktop: the price comes under the picker, not beside it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockApi(page);
  await page.goto("/pay/c-1");
  await pick(page);
  const picker = page.getByRole("region", { name: "Pay this invoice" });
  const quote = page.getByRole("region", { name: "Your price" });
  await expect(quote).toBeVisible();
  const a = (await picker.boundingBox())!;
  const b = (await quote.boundingBox())!;
  expect(b.y).toBeGreaterThan(a.y + a.height - 1);
  expect(Math.abs(b.x - a.x)).toBeLessThan(2);
  // The column is centered in the window.
  expect(Math.abs(a.x + a.width / 2 - 640)).toBeLessThan(8);
});

test("one column on a phone, in reading order", async ({ page }) => {
  await mockApi(page);
  await page.goto("/pay/c-1");
  await pick(page);
  const picker = (await page.getByRole("region", { name: "Pay this invoice" }).boundingBox())!;
  const quote = (await page.getByRole("region", { name: "Your price" }).boundingBox())!;
  expect(quote.y).toBeGreaterThan(picker.y + picker.height - 1);
  expect(Math.abs(quote.x - picker.x)).toBeLessThan(2);
});
