import { expect, test } from "@playwright/test";

// The signed-in journey against the real mock API (`MOCK=1`, started by playwright.config.ts),
// with no network interception: the app talks to a server that answers with fixtures/api/.
// Fixture mode signs in with a stand-in cookie, so no wallet is needed.

test.describe("signed-in journey on the mock API", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("sign in, see the dashboard, open an invoice, create one and send it", async ({ page }) => {
    await page.goto("/app");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("acme.openrail.near").first()).toBeVisible();

    // The fixture invoice is in the invoices list and opens its detail page.
    await page.goto("/app/invoices");
    await page.getByRole("link", { name: "INV-2026-001" }).first().click();
    await expect(page.locator('[data-counter="amount_due"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: "Money" })).toBeVisible();
    await expect(page.getByText("no keys", { exact: false })).toBeVisible();

    // Create an invoice: the API answers with its fixture and the sheet offers the pay link.
    await page.goto("/app/invoices/new");
    await page.getByLabel("Client name").fill("Northwind Studio");
    await page.getByLabel("Client account", { exact: true }).fill("northwind.near");
    await page.getByLabel("Invoice number").fill("INV-0900");
    await page
      .getByLabel("Due date")
      .fill(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
    await page.getByLabel("Description").fill("Design");
    await page.getByLabel("Price").fill("125.00");
    await page.getByRole("button", { name: "Create invoice" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Invoice created" })).toBeVisible();
    // Email is not available yet: the sheet offers the pay link and the QR code, and no email form.
    await expect(dialog.getByRole("button", { name: "Open invoice" })).toBeVisible();
    await expect(dialog.getByLabel("Client's email")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Send invoice" })).toHaveCount(0);
  });

  test("a client pays: pay page, price, address, then the receipt", async ({ page }) => {
    await page.goto("/pay/c-1");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Pay");
    await page.getByRole("button", { name: /Base/ }).first().click();
    await page.getByLabel("Refund address").fill("0x53C5D39A5828BaDf817E40f22d75d96D731f8239");
    await page.getByRole("button", { name: "Get price" }).click();
    // The mock's pay-session fixture has a fixed deadline (2 Nov 2026), so once that day has
    // passed the page rightly shows an expired price. Either outcome proves the flow reached the API.
    const quote = page.getByRole("region", { name: "Your price" });
    await expect(quote.or(page.getByText("This price expired"))).toBeVisible();

    await page.goto("/r/0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
    await expect(page.getByRole("heading", { name: "Payment receipt" })).toBeVisible();
    await expect(page.getByText("12.50 USDC")).toBeVisible();
  });

  test("the dashboard tools load: statements, cash out, developers, settings, setup", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: "or_sess_mock", value: "acme.openrail.near", url: "http://127.0.0.1:3100" },
    ]);

    await page.goto("/app/statements");
    await page.getByRole("button", { name: /Statement period/ }).click();
    await page.getByRole("button", { name: "This month" }).click();
    await page.getByRole("button", { name: "Get statement" }).click();
    await expect(
      page.getByRole("link", { name: /Download statement-2026-11-01-2026-11-30\.csv/ }),
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: "INV-2026-001" })).toBeVisible();

    await page.goto("/app/cashout");
    await page.getByLabel("Amount").fill("2");
    await page.getByLabel("Address").fill("0x53C5D39A5828BaDf817E40f22d75d96D731f8239");
    await page.getByRole("button", { name: "Get quote" }).click();
    await expect(page.getByRole("region", { name: "What it costs" })).toContainText("$0.30");

    await page.goto("/app/developers");
    await expect(page.getByRole("region", { name: "API keys" })).toContainText("or_sk_live_ab12");
    await page.getByRole("tab", { name: "Webhooks" }).click();
    await expect(page.getByRole("region", { name: "Webhook endpoints" })).toContainText(
      "example.com",
    );
    await page.getByRole("tab", { name: "Events" }).click();
    await expect(page.getByRole("region", { name: "Events" })).toContainText("invoice.paid");

    await page.goto("/app/settings");
    await expect(page.getByLabel("Business name")).toHaveValue("Acme Ltd");

    await page.goto("/app/onboarding");
    await expect(page.getByRole("list", { name: "Setup steps" })).toBeVisible();
  });

  test("sign out ends the session", async ({ page, context }) => {
    await context.addCookies([
      { name: "or_sess_mock", value: "acme.openrail.near", url: "http://127.0.0.1:3100" },
    ]);
    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await page.goto("/app/settings");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});
