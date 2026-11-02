import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

test("lists only open pay-link quotes before the seller signs", async ({ page }) => {
  await page.goto("/app/invoices/c-3/transfer");
  const quotes = page.getByRole("region", { name: "Open payment links" });
  await expect(quotes.getByRole("row").or(quotes.getByRole("listitem"))).not.toHaveCount(0);
  await expect(quotes.getByText("R1").first()).toBeVisible();
  await expect(quotes.getByText("R13").first()).toBeVisible();
  await expect(quotes.getByText("R2")).toHaveCount(0); // expired
  await expect(quotes).toContainText("before the sale");
});

test("no open quotes shows an empty state", async ({ page }) => {
  await page.goto("/app/invoices/c-1/transfer");
  await expect(page.getByText("No open payment links")).toBeVisible();
});

test("refuses with the rule number in plain words", async ({ page }) => {
  await page.goto("/app/invoices/c-4/transfer");
  await expect(page.locator("main [role=alert]")).toContainText("Rule 2:");
  await expect(page.getByRole("button", { name: "Prepare sale" })).toBeDisabled();

  await page.goto("/app/invoices/c-1/transfer");
  await expect(page.locator("main [role=alert]")).toContainText("Rule 3:");
  await expect(page.locator("main [role=alert]")).toContainText("hasn't accepted");
});

test("document is hashed in the browser; only the fingerprint is shown", async ({ page }) => {
  await page.goto("/app/invoices/c-3/transfer");
  await page.getByLabel("Assignment document").setInputFiles({
    name: "assignment.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("hello"),
  });
  await expect(page.getByText(HELLO_SHA256)).toBeVisible();
});

test("sale flow: prepare, then sign, then done (fixture mode)", async ({ page }) => {
  await page.goto("/app/invoices/c-3/transfer");
  await expect(page.getByRole("button", { name: "Sign sale" })).toBeDisabled();
  await page.getByLabel("Buyer account").fill("fund.near");
  await page.getByLabel("Assignment document").setInputFiles({
    name: "assignment.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("hello"),
  });
  await expect(page.locator("main [role=alert]")).toHaveCount(0);
  await page.getByRole("button", { name: "Prepare sale" }).click();
  await expect(page.getByRole("button", { name: "Sign sale" })).toBeEnabled();
  await page.getByRole("button", { name: "Sign sale" }).click();
  await expect(page.getByText("Sale sent")).toBeVisible();
});

test("a malformed buyer account is refused", async ({ page }) => {
  await page.goto("/app/invoices/c-3/transfer");
  await page.getByLabel("Buyer account").fill("Not An Account");
  await expect(page.locator("main [role=alert]")).toContainText("valid NEAR account");
});

test("not found", async ({ page }) => {
  await page.goto("/app/invoices/c-404/transfer");
  await expect(page.getByRole("heading", { name: "We can't find this invoice" })).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`transfer page at 360px, ${scheme}: no scroll, no WCAG AA violations`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/app/invoices/c-3/transfer");
    await expect(page.getByRole("button", { name: "Prepare sale" })).toBeVisible();
    await page.waitForTimeout(400);
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

test("keyboard: the sale form is reachable in order", async ({ page }) => {
  await page.goto("/app/invoices/c-3/transfer");
  await page.getByLabel("Buyer account").focus();
  await page.keyboard.type("fund.near");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Assignment document")).toBeFocused();
});
