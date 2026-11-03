import { expect, test, type Page } from "@playwright/test";
import { fixture, mockApi, type Handlers } from "./api-mock";
import { signIn } from "./helpers";
import { axeClean } from "./setup-axe";

// The states checklist (docs/src/core/ui-states.md): for every screen, loading, empty, error, 360 px
// in both themes, keyboard. Per-screen specs prove most of it; this file closes the gaps and holds
// the loading and keyboard checks for every screen in one place.

const HOLD = 6000;
const ok = (body: unknown, extra: Record<string, unknown> = {}) => ({ body, ...extra });
const fail = { status: 500, body: { error: { code: "internal", message: "x" } } };
const RECEIPT_HASH = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

const INV = fixture("invoices.list");
const DETAIL = fixture("invoices.get");

/** Answers for every call a signed-in screen may make, so a state test changes only what it needs. */
const base = (): Handlers => ({
  "GET /v1/invoices": ok(INV),
  "GET /v1/invoices/{id}": ok(DETAIL),
  "GET /v1/invoices/{id}/receipts": ok(fixture("invoices.receipts")),
  "GET /v1/invoices/{id}/open_quotes": ok({ data: [] }),
  "GET /v1/events": ok(fixture("events.list")),
  "GET /v1/payments": ok({ data: [] }),
  "GET /v1/business": ok(fixture("business.get")),
  "GET /v1/business/storage_credit": ok(fixture("business.storage_credit")),
  "GET /v1/api_keys": ok(fixture("api_keys.list")),
  "GET /v1/webhook_endpoints": ok(fixture("webhook_endpoints.list")),
  "GET /v1/webhook_endpoints/{id}/deliveries": ok(fixture("webhook_endpoints.deliveries")),
  "GET /v1/pay/claims/{id}": ok(fixture("pay.claims.get")),
  "GET /v1/receipts/{id}": ok(fixture("receipts.get")),
  "GET /v1/statements": ok(fixture("statements.get")),
  "POST /v1/cashout/quote": ok(fixture("cashout.quote"), { status: 201 }),
});

const skeleton = (page: Page) => page.locator("main .skeleton").first();

test.describe("loading: a skeleton while the answer is on its way, never a blank page", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  const screens: [string, string, string][] = [
    ["dashboard", "/app", "GET /v1/invoices"],
    ["invoices list", "/app/invoices", "GET /v1/invoices"],
    ["claim detail", "/app/invoices/inv_01J00000000000000000000000", "GET /v1/invoices/{id}"],
    ["issue form (business name)", "/app/invoices/new", "GET /v1/business"],
    ["onboarding", "/app/onboarding", "GET /v1/business"],
    ["settings", "/app/settings", "GET /v1/business"],
    ["developers, API keys", "/app/developers", "GET /v1/api_keys"],
    ["pay page", "/pay/c-1", "GET /v1/pay/claims/{id}"],
    ["receipt", `/r/${RECEIPT_HASH}`, "GET /v1/receipts/{id}"],
  ];
  for (const [name, path, key] of screens)
    test(name, async ({ page }) => {
      await mockApi(page, {
        ...base(),
        [key]: { ...(base()[key] as object), delayMs: HOLD } as never,
      });
      await page.goto(path, { waitUntil: "commit" });
      await expect(skeleton(page)).toBeVisible();
    });

  test("developers, webhooks and events tabs", async ({ page }) => {
    await mockApi(page, {
      ...base(),
      "GET /v1/webhook_endpoints": {
        ...(base()["GET /v1/webhook_endpoints"] as object),
        delayMs: HOLD,
      } as never,
      "GET /v1/events": { ...(base()["GET /v1/events"] as object), delayMs: HOLD } as never,
    });
    await page.goto("/app/developers");
    await page.getByRole("tab", { name: "Webhooks" }).click();
    await expect(skeleton(page)).toBeVisible();
    await page.getByRole("tab", { name: "Events" }).click();
    await expect(skeleton(page)).toBeVisible();
  });

  test("the session check shows a skeleton, not a flash of the sign-in card", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: "or_sess_mock", value: "__slow", url: "http://127.0.0.1:3100" },
    ]);
    await page.goto("/app", { waitUntil: "commit" });
    await expect(skeleton(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  });

  test("ack page and transfer page (fixture mode)", async ({ page }) => {
    await page.goto("/ack/c-slow", { waitUntil: "commit" });
    await expect(skeleton(page)).toBeVisible();
    await page.goto("/app/invoices/c-slow/transfer", { waitUntil: "commit" });
    await expect(skeleton(page)).toBeVisible();
  });

  test("statements and cash out show a busy button while they work", async ({ page }) => {
    await mockApi(page, {
      ...base(),
      "GET /v1/statements": { ...(base()["GET /v1/statements"] as object), delayMs: HOLD } as never,
      "POST /v1/cashout/quote": {
        ...(base()["POST /v1/cashout/quote"] as object),
        delayMs: HOLD,
      } as never,
    });
    await page.goto("/app/statements");
    await page.getByLabel("From", { exact: true }).fill("2026-11-01");
    await page.getByLabel("To", { exact: true }).fill("2026-11-30");
    await page.getByRole("button", { name: /Get statement|Preparing/ }).click();
    await expect(page.getByRole("button", { name: "Preparing your statement" })).toHaveAttribute(
      "aria-busy",
      "true",
    );

    await page.goto("/app/cashout");
    await page.getByLabel("Amount").fill("2");
    await page.getByLabel("Address").fill("0x53C5D39A5828BaDf817E40f22d75d96D731f8239");
    await page.getByRole("button", { name: "Get quote" }).click();
    await expect(page.getByRole("button", { name: "Getting your quote" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});

test.describe("empty and error: the gaps the per-screen specs leave", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test("invoices list: an empty tab and an empty list", async ({ page }) => {
    await mockApi(page, { ...base(), "GET /v1/invoices": ok({ data: [], next_cursor: null }) });
    await page.goto("/app/invoices");
    await expect(page.getByText("No invoices yet").first()).toBeVisible();
  });

  test("invoices list: a failed load says so and retries", async ({ page }) => {
    let down = true;
    await mockApi(page, { ...base(), "GET /v1/invoices": () => (down ? fail : ok(INV)) });
    await page.goto("/app/invoices");
    await expect(page.locator("main [role=alert]").first()).toBeVisible();
    down = false;
    await page.getByRole("button", { name: "Try again" }).first().click();
    await expect(page.getByRole("link", { name: "INV-2026-001" }).first()).toBeVisible();
  });

  test("claim detail: a failed load says so and retries", async ({ page }) => {
    let down = true;
    await mockApi(page, { ...base(), "GET /v1/invoices/{id}": () => (down ? fail : ok(DETAIL)) });
    await page.goto("/app/invoices/inv_01J00000000000000000000000");
    await expect(page.locator("main [role=alert]").first()).toBeVisible();
    down = false;
    await page.getByRole("button", { name: "Try again" }).first().click();
    await expect(page.locator('[data-counter="amount_due"]')).toBeVisible();
  });

  test("transfer page: a failed load says so and retries", async ({ page }) => {
    await page.goto("/app/invoices/c-error/transfer");
    await expect(page.locator("main [role=alert]").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("pay page: no payment options is said plainly", async ({ page }) => {
    await mockApi(page, {
      ...base(),
      "GET /v1/pay/claims/{id}": ok({ ...fixture("pay.claims.get"), routes: [] }),
    });
    await page.goto("/pay/c-1");
    await expect(page.getByText("No payment options are available right now")).toBeVisible();
  });

  test("developers: webhooks and events, empty and failed", async ({ page }) => {
    await mockApi(page, {
      ...base(),
      "GET /v1/webhook_endpoints": ok({ data: [] }),
      "GET /v1/events": ok({ data: [], next_cursor: null }),
    });
    await page.goto("/app/developers");
    await page.getByRole("tab", { name: "Webhooks" }).click();
    await expect(page.getByText("No webhook endpoints yet")).toBeVisible();

    const p2 = await page.context().newPage();
    await mockApi(p2, { ...base(), "GET /v1/webhook_endpoints": fail, "GET /v1/events": fail });
    await p2.goto("/app/developers");
    await p2.getByRole("tab", { name: "Webhooks" }).click();
    await expect(
      p2
        .getByRole("region", { name: "Webhook endpoints" })
        .getByRole("button", { name: "Try again" }),
    ).toBeVisible();
    await p2.getByRole("tab", { name: "Events" }).click();
    await expect(
      p2.getByRole("region", { name: "Events" }).getByRole("button", { name: "Try again" }),
    ).toBeVisible();
  });
});

test.describe("360 px in both themes: the screens the per-screen specs do not cover", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`invoices list, ${scheme}`, async ({ page, context }) => {
      await signIn(context);
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page, base());
      await page.goto("/app/invoices");
      await expect(page.getByRole("link", { name: "INV-2026-001" }).first()).toBeVisible();
      await axeClean(page);
    });

    test(`sign-in card, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/app");
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      await axeClean(page);
    });

    test(`wallet picker, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/_dev/components");
      await page.getByRole("button", { name: "Open wallet picker" }).click();
      await expect(
        page.getByRole("dialog").getByRole("heading", { name: "Choose a wallet" }),
      ).toBeVisible();
      await axeClean(page);
    });
  }
});

/**
 * Tab through a page. Every stop must be visible and show the solid 2 px focus ring (DESIGN.md), and
 * focus must leave or come back to the start, never trap.
 */
async function keyboardWalk(page: Page, min: number) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  const seen: {
    index: number;
    name: string;
    visible: boolean;
    style: string;
    width: string;
    file: boolean;
  }[] = [];
  let ended = false;
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        index: Array.from(document.querySelectorAll("*")).indexOf(el),
        name: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 30),
        visible: r.width > 0 && r.height > 0,
        style: cs.outlineStyle,
        width: cs.outlineWidth,
        file: el instanceof HTMLInputElement && el.type === "file",
      };
    });
    if (!info || seen.some((s) => s.index === info.index)) {
      ended = true;
      break;
    }
    seen.push(info);
  }
  expect(ended, "focus must not be trapped").toBe(true);
  expect(seen.length).toBeGreaterThanOrEqual(min);
  for (const s of seen) {
    expect(s.visible, `${s.name} is focusable but not visible`).toBe(true);
    if (!s.file) {
      expect(s.style, `${s.name} focus ring`).toBe("solid");
      expect(s.width, `${s.name} focus ring`).toBe("2px");
    }
  }
}

test.describe("keyboard: every control is reachable and shows the focus ring", () => {
  const signed: [string, string, number][] = [
    ["dashboard", "/app", 6],
    ["invoices list", "/app/invoices", 6],
    ["claim detail", "/app/invoices/inv_01J00000000000000000000000", 6],
    ["issue form", "/app/invoices/new", 8],
    ["statements", "/app/statements", 6],
    ["cash out", "/app/cashout", 6],
    ["onboarding", "/app/onboarding", 6],
    ["settings", "/app/settings", 6],
    ["developers", "/app/developers", 6],
    ["transfer", "/app/invoices/c-3/transfer", 6],
  ];
  for (const [name, path, min] of signed)
    test(name, async ({ page, context }) => {
      await signIn(context);
      await page.setViewportSize({ width: 1280, height: 900 });
      await mockApi(page, base());
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).waitFor();
      // Wait for the data to arrive: a page still showing skeletons has fewer stops.
      await expect(page.locator("main .skeleton")).toHaveCount(0);
      await page.waitForTimeout(300);
      await keyboardWalk(page, min);
    });

  const open: [string, string, number][] = [
    ["sign-in card", "/app", 3],
    ["pay page", "/pay/c-1", 3],
    ["receipt", `/r/${RECEIPT_HASH}`, 3],
    ["ack page", "/ack/c-1", 4],
  ];
  for (const [name, path, min] of open)
    test(name, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await mockApi(page, base());
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      // Wait for the data to arrive: a page still showing skeletons has fewer stops.
      await expect(page.locator("main .skeleton")).toHaveCount(0);
      await page.waitForTimeout(300);
      await keyboardWalk(page, min);
    });
});
