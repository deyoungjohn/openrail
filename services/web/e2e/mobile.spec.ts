import { devices, expect, test, type Page } from "@playwright/test";
import { fixture, mockApi, type Handlers } from "./api-mock";
import { signIn, pickRoute } from "./helpers";

// The mobile pass (update 27): real phone sizes with touch, no sideways scroll, tap targets of at
// least 44 px, the QR panel and the address usable with one thumb, the wallet picker as a bottom sheet.

const ok = (body: unknown, extra: Record<string, unknown> = {}) => ({ body, ...extra });
const SIGNER = "0x53C5D39A5828BaDf817E40f22d75d96D731f8239";
const HASH = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

// Playwright's descriptors name WebKit for the iPhone; the pre-installed browser is Chromium, so keep
// the size, pixel ratio, touch and user agent and drop the browser type.
const chromiumOnly = (d: (typeof devices)[string]) =>
  Object.fromEntries(Object.entries(d).filter(([k]) => k !== "defaultBrowserType"));
const PHONES = {
  "iPhone SE": chromiumOnly(devices["iPhone SE"]!),
  "Pixel 7": chromiumOnly(devices["Pixel 7"]!),
};

const api = (): Handlers => ({
  "GET /v1/invoices": ok(fixture("invoices.list")),
  "GET /v1/invoices/{id}": ok(fixture("invoices.get")),
  "GET /v1/invoices/{id}/receipts": ok(fixture("invoices.receipts")),
  "GET /v1/invoices/{id}/open_quotes": ok({ data: [] }),
  "GET /v1/events": ok(fixture("events.list")),
  "GET /v1/payments": ok({ data: [] }),
  "GET /v1/business": ok(fixture("business.get")),
  "GET /v1/business/storage_credit": ok(fixture("business.storage_credit")),
  "GET /v1/api_keys": ok(fixture("api_keys.list")),
  "GET /v1/webhook_endpoints": ok(fixture("webhook_endpoints.list")),
  "GET /v1/pay/claims/{id}": ok(fixture("pay.claims.get")),
  "POST /v1/pay/sessions": ok(
    {
      ...fixture("pay.sessions.create"),
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
    { status: 201 },
  ),
  "GET /v1/pay/sessions/{id}": ok({ ...fixture("pay.sessions.status"), status: "pending_deposit" }),
  "GET /v1/receipts/{id}": ok(fixture("receipts.get")),
  "GET /v1/statements": ok(fixture("statements.get")),
  "POST /v1/cashout/quote": ok(fixture("cashout.quote"), { status: 201 }),
});

const screens: [string, string, boolean][] = [
  ["dashboard", "/app", true],
  ["invoices list", "/app/invoices", true],
  ["claim detail", "/app/invoices/inv_01J00000000000000000000000", true],
  ["issue form", "/app/invoices/new", true],
  ["statements", "/app/statements", true],
  ["cash out", "/app/cashout", true],
  ["settings", "/app/settings", true],
  ["developers", "/app/developers", true],
  ["onboarding", "/app/onboarding", true],
  ["transfer", "/app/invoices/c-3/transfer", true],
  ["ack", "/ack/c-1", false],
  ["pay", "/pay/c-1", false],
  ["receipt", `/r/${HASH}`, false],
];

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await expect(page.locator("main .skeleton")).toHaveCount(0);
  await page.waitForTimeout(300);
}

/** Interactive controls on the page that are smaller than 44 px in either direction. */
const smallTargets = (page: Page) =>
  page.evaluate(() => {
    const small: string[] = [];
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const nameOf = (el: Element) =>
      (el.getAttribute("aria-label") || el.textContent || el.tagName)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
    for (const el of document.querySelectorAll("button, [role=tab], select, input, a[href]")) {
      if (!visible(el)) continue;
      // A link inside a sentence is exempt (WCAG 2.5.8 inline exception); so is the skip link.
      if (
        el instanceof HTMLAnchorElement &&
        (el.closest("p, li > span, dd, td") ||
          el.querySelector("button") ||
          el.textContent?.includes("Skip"))
      )
        continue;
      let target: Element = el;
      if (el instanceof HTMLInputElement) {
        if (el.type === "hidden") continue;
        // A checkbox is operated through its label row.
        if (el.type === "checkbox" || el.type === "radio") target = el.closest("label") ?? el;
      }
      const r = target.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5)
        small.push(
          `${el.tagName.toLowerCase()} "${nameOf(el)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
    }
    return [...new Set(small)];
  });

for (const [phone, device] of Object.entries(PHONES)) {
  test.describe(`${phone}`, () => {
    test.use({ ...device });

    test("the phone reports a coarse pointer, so touch sizing applies", async ({ page }) => {
      await page.goto("/_dev/components");
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    });

    for (const [name, path, signed] of screens)
      test(`${name}: no sideways scroll and every tap target is at least 44 px`, async ({
        page,
        context,
      }) => {
        if (signed) await signIn(context);
        await mockApi(page, api());
        await open(page, path);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        expect(await smallTargets(page)).toEqual([]);
      });

    test("pay page with a price: the QR panel and the address fit and are usable with one thumb", async ({
      page,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
      await mockApi(page, api());
      await open(page, "/pay/c-1");
      await pickRoute(page, "USDC on Base");
      await page.getByLabel("Refund address").fill(SIGNER);
      await page.getByRole("button", { name: "Get price" }).click();
      const quote = page.getByRole("region", { name: "Your price" });
      await expect(quote).toBeVisible();
      const vp = page.viewportSize()!;
      // The QR code is fully inside the screen width.
      const qr = (await page
        .locator("[role=dialog] svg[role=img], [role=dialog] svg")
        .filter({ has: page.locator("title") })
        .first()
        .boundingBox())!;
      expect(qr.x).toBeGreaterThanOrEqual(0);
      expect(qr.x + qr.width).toBeLessThanOrEqual(vp.width);
      // A full-width, thumb-sized "Copy address" button sits under the code.
      const copy = page.getByRole("button", { name: "Copy address" });
      await expect(copy).toBeVisible();
      const b = (await copy.boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.width).toBeGreaterThanOrEqual(200);
      await copy.click();
      await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        fixture("pay.sessions.create").deposit_address,
      );
    });

    test("wallet picker: a centered dialog that fits the screen and scrolls inside", async ({
      page,
    }) => {
      await page.goto("/_dev/components");
      await page.getByRole("button", { name: "Open wallet picker" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(500);
      const vp = page.viewportSize()!;
      const box = (await dialog.boundingBox())!;
      // Inside the window on every side, centered, never taller than the screen.
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
      expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(8);
      expect(box.height).toBeLessThanOrEqual(vp.height * 0.95 + 1);
      // Its rows are thumb-sized.
      for (const row of await dialog.getByRole("button", { name: /Wallet/ }).all()) {
        const r = (await row.boundingBox())!;
        expect(r.height).toBeGreaterThanOrEqual(44);
      }
    });
  });
}
