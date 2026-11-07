import { expect, test, type Page } from "@playwright/test";
import { fixture, mockApi, type Handlers } from "./api-mock";
import { signIn } from "./helpers";

// The accessibility sweep (update 26): reduced motion stops loading animations, the tab order on the
// pages with forms and wallets follows the visual order, and every icon-only control has a name.

const ok = (body: unknown, extra: Record<string, unknown> = {}) => ({ body, ...extra });
const SIGNER = "0x53C5D39A5828BaDf817E40f22d75d96D731f8239";

const base = (): Handlers => ({
  "GET /v1/business": ok(fixture("business.get")),
  "GET /v1/business/storage_credit": ok(fixture("business.storage_credit")),
  "GET /v1/pay/claims/{id}": ok(fixture("pay.claims.get")),
  "POST /v1/pay/sessions": ok(
    {
      ...fixture("pay.sessions.create"),
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
    { status: 201 },
  ),
  "GET /v1/pay/sessions/{id}": ok({ ...fixture("pay.sessions.status"), status: "pending_deposit" }),
});

/** An injected browser wallet, so the wallet button is enabled. */
async function injectWallet(page: Page) {
  await page.addInitScript((account) => {
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: async ({ method }: { method: string }) =>
        method === "eth_accounts" || method === "eth_requestAccounts" ? [account] : null,
      on: () => {},
      removeListener: () => {},
    };
  }, SIGNER);
}

/** The accessible name of each focus stop inside <main>, in Tab order, starting at the top of main. */
async function mainTabOrder(page: Page): Promise<string[]> {
  await page.locator("main").evaluate((m) => {
    m.setAttribute("tabindex", "-1");
    (m as HTMLElement).focus();
  });
  const names: string[] = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.closest("main")) return null;
      const label = (el as HTMLInputElement).labels?.[0]?.textContent;
      // Text a screen reader would not read: content hidden with aria-hidden is left out.
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("[aria-hidden=true]").forEach((n) => n.remove());
      return (
        el.getAttribute("aria-label") ||
        label ||
        clone.textContent ||
        el.getAttribute("title") ||
        el.tagName
      )
        .replace(/\s+/g, " ")
        .trim();
    });
    if (stop === null) break;
    // A native date field has one stop per segment; they read as one control.
    if (names[names.length - 1] !== stop) names.push(stop);
  }
  return names;
}

const expectOrder = (actual: string[], expected: (string | RegExp)[]) => {
  expect(actual, `focus order was: ${actual.join(" | ")}`).toHaveLength(expected.length);
  expected.forEach((e, i) => {
    if (typeof e === "string") expect(actual[i]).toBe(e);
    else expect(actual[i]).toMatch(e);
  });
};

test.describe("reduced motion stops the loading animations", () => {
  test.use({ reducedMotion: "reduce" });

  test("a skeleton and a busy button do not animate", async ({ page, context }) => {
    await signIn(context);
    await mockApi(page, {
      ...base(),
      "GET /v1/business": { ...(base()["GET /v1/business"] as object), delayMs: 6000 } as never,
      "POST /v1/cashout/quote": {
        ...ok(fixture("cashout.quote"), { status: 201 }),
        delayMs: 6000,
      } as never,
    });
    await page.goto("/app/settings", { waitUntil: "commit" });
    const duration = (sel: string) =>
      page
        .locator(sel)
        .first()
        .evaluate(
          (el) =>
            parseFloat(getComputedStyle(el).animationDuration) *
            (getComputedStyle(el).animationDuration.includes("ms") ? 1 : 1000),
        );
    await expect(page.locator("main .skeleton").first()).toBeVisible();
    expect(await duration("main .skeleton")).toBeLessThanOrEqual(1);

    await page.goto("/app/cashout");
    await page.getByLabel("Amount").fill("2");
    await page.getByLabel("Address").fill(SIGNER);
    await page.getByRole("button", { name: "Get quote" }).click();
    const busy = page.getByRole("button", { name: "Getting your quote" });
    await expect(busy).toHaveAttribute("aria-busy", "true");
    expect(await duration('button[aria-busy="true"] svg')).toBeLessThanOrEqual(1);
  });
});

test.describe("tab order follows the visual order", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("issue form: top to bottom, left to right, then the action", async ({ page, context }) => {
    await signIn(context);
    await mockApi(page, base());
    await page.goto("/app/invoices/new");
    await expect(page.getByLabel("Client name")).toBeVisible();
    await expect(page.locator("main .skeleton")).toHaveCount(0);
    expectOrder(await mainTabOrder(page), [
      "From",
      "Client name",
      /^Client pays with/,
      "Client account",
      "Invoice number",
      /^Due date/,
      "Description",
      "Qty",
      "Price",
      "Add line",
      "Create invoice",
    ]);
  });

  test("ack page: the details first, then the wallet, then the confirm button", async ({
    page,
  }) => {
    await injectWallet(page);
    await page.goto("/ack/c-1");
    await expect(page.getByRole("button", { name: "Confirm with wallet" })).toBeVisible();
    expectOrder(await mainTabOrder(page), [
      /^Copy 0x82c0/,
      /^Copy c-1\.op/,
      // The stand-in wallet is already connected: its address, then disconnect, then the confirm button.
      /^Copy 0x53C5/,
      "Disconnect",
      "Confirm with wallet",
    ]);
  });

  test("pay page: the networks, then the refund address, then the price, then the address to copy", async ({
    page,
  }) => {
    await mockApi(page, base());
    await page.goto("/pay/c-1");
    await expect(page.getByRole("button", { name: /USDC on Base/ })).toBeVisible();
    // The selected tab is the one stop of the tab list; the other tab is reached with the arrow keys.
    expectOrder(await mainTabOrder(page), [
      "Pay from any wallet or exchange",
      "USDC on Base",
      "USDC on BNB Chain",
      "Split this payment",
    ]);

    await page.getByRole("button", { name: /USDC on Base/ }).click();
    await page.getByLabel("Refund address").fill(SIGNER);
    await page.getByRole("button", { name: "Get price" }).click();
    await expect(page.getByRole("region", { name: "Your price" })).toBeVisible();
    const order = await mainTabOrder(page);
    const idx = (re: RegExp) => order.findIndex((n) => re.test(n));
    expect(idx(/USDC on Base/), order.join(" | ")).toBeLessThan(idx(/^Refund address$/));
    expect(idx(/^Refund address$/)).toBeLessThan(idx(/^Get price$/));
    expect(idx(/^Get price$/)).toBeLessThan(idx(/^Copy 0xeeee/));
  });

  test("transfer page: the terms, the open payment links, then the buyer and the agreement", async ({
    page,
    context,
  }) => {
    await signIn(context);
    await page.goto("/app/invoices/c-3/transfer");
    await expect(page.getByLabel("Buyer account")).toBeVisible();
    await expect(page.locator("main .skeleton")).toHaveCount(0);
    const order = await mainTabOrder(page);
    expect(order[0], order.join(" | ")).toMatch(/^Copy 0x82c0/);
    expect(order[1]).toMatch(/^Copy c-3\.op/);
    const buyer = order.indexOf("Buyer account");
    const agreement = order.indexOf("Sale agreement");
    expect(buyer, order.join(" | ")).toBeGreaterThan(1);
    expect(agreement).toBe(buyer + 1);
    // Every payment link's copy button comes before the sale form.
    order.slice(2, buyer).forEach((n) => expect(n).toMatch(/^Copy /));
  });
});

test.describe("every icon-only control has a screen-reader name", () => {
  const pages: [string, string, boolean][] = [
    ["dashboard", "/app", true],
    ["invoices list", "/app/invoices", true],
    ["claim detail", "/app/invoices/inv_01J00000000000000000000000", true],
    ["issue form", "/app/invoices/new", true],
    ["statements", "/app/statements", true],
    ["cash out", "/app/cashout", true],
    ["developers", "/app/developers", true],
    ["settings", "/app/settings", true],
    ["onboarding", "/app/onboarding", true],
    ["transfer", "/app/invoices/c-3/transfer", true],
    ["ack", "/ack/c-1", false],
    ["pay", "/pay/c-1", false],
    ["receipt", "/r/0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", false],
    ["component gallery", "/_dev/components", false],
  ];
  for (const [name, path, signed] of pages)
    test(name, async ({ page, context }) => {
      if (signed) await signIn(context);
      await page.setViewportSize({ width: 360, height: 900 });
      await mockApi(page, {
        ...base(),
        "GET /v1/invoices": ok(fixture("invoices.list")),
        "GET /v1/invoices/{id}": ok(fixture("invoices.get")),
        "GET /v1/invoices/{id}/receipts": ok(fixture("invoices.receipts")),
        "GET /v1/invoices/{id}/open_quotes": ok({ data: [] }),
        "GET /v1/events": ok(fixture("events.list")),
        "GET /v1/payments": ok({ data: [] }),
        "GET /v1/api_keys": ok(fixture("api_keys.list")),
        "GET /v1/webhook_endpoints": ok(fixture("webhook_endpoints.list")),
        "GET /v1/receipts/{id}": ok(fixture("receipts.get")),
      });
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      // The gallery shows skeletons on purpose.
      if (!path.startsWith("/_dev")) await expect(page.locator("main .skeleton")).toHaveCount(0);
      const bad = await page.evaluate(() => {
        const problems: string[] = [];
        const accessibleName = (el: Element) =>
          (
            el.getAttribute("aria-label") ||
            (el.getAttribute("aria-labelledby")
              ? document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent
              : "") ||
            (el as HTMLInputElement).labels?.[0]?.textContent ||
            el.textContent ||
            el.getAttribute("title") ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
        for (const el of document.querySelectorAll("button, a[href], [role=button], [role=tab]")) {
          const label = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)}`;
          const n = accessibleName(el);
          if (n === "") problems.push(`${label} has no name`);
          // An icon next to text must be hidden from screen readers; an icon-only control must be named by its own label.
          const iconOnly = (el.textContent ?? "").trim() === "" && el.querySelector("svg");
          if (iconOnly && !el.getAttribute("aria-label") && !el.getAttribute("title"))
            problems.push(`${label} is icon-only without aria-label`);
          for (const svg of el.querySelectorAll("svg"))
            if (
              svg.getAttribute("aria-hidden") !== "true" &&
              !svg.getAttribute("aria-label") &&
              !svg.querySelector("title")
            )
              problems.push(`${label} has an icon that is not hidden from screen readers`);
        }
        return problems;
      });
      expect(bad).toEqual([]);
    });
});
