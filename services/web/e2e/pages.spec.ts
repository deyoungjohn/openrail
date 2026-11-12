import { expect, test } from "@playwright/test";
import { fixture, mockApi } from "./api-mock";
import { signIn } from "./helpers";

const ok = (body: unknown) => ({ body });

test("an unknown address shows a 404 page with links to the main pages", async ({ page }) => {
  const response = await page.goto("/this-page-does-not-exist/at-all");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This page doesn't exist");
  const nav = page.getByRole("navigation", { name: "Pages you may be looking for" });
  await expect(nav.getByRole("link", { name: /Dashboard/ })).toHaveAttribute("href", "/app");
  await expect(nav.getByRole("link", { name: /Create an invoice/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Pay out/ })).toBeVisible();
});

test("the Payments page lists payments and opens a row for the rest", async ({ page, context }) => {
  await signIn(context);
  await mockApi(page, {
    "GET /v1/invoices": ok({
      ...(fixture("invoices.list") as { data: Record<string, unknown>[] }),
      data: (fixture("invoices.list") as { data: Record<string, unknown>[] }).data.map((i) => ({
        ...i,
        status: "Paid",
        paid_total: "10000000",
      })),
    }),
    "GET /v1/invoices/{id}/receipts": ok(fixture("invoices.receipts")),
    "GET /v1/events": ok(fixture("events.list")),
    "GET /v1/payments": ok({ data: [] }),
    "GET /v1/business": ok(fixture("business.get")),
    "GET /v1/business/storage_credit": ok(fixture("business.storage_credit")),
  });
  await page.goto("/app/payments");
  await expect(page.getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
  const toggle = page.getByRole("button", { name: "Show details" }).first();
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByText("Network").first()).toBeVisible();
});
