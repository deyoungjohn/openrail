import { expect, test } from "@playwright/test";
import { mockApi, fixture } from "./api-mock";
import { signIn } from "./helpers";

const ok = (body: unknown) => ({ body });
const handlers = () => ({
  "GET /v1/invoices": ok(fixture("invoices.list")),
  "GET /v1/invoices/{id}/receipts": ok(fixture("invoices.receipts")),
  "GET /v1/events": ok(fixture("events.list")),
  "GET /v1/payments": ok({ data: [] }),
  "GET /v1/business": ok(fixture("business.get")),
  "GET /v1/business/storage_credit": ok(fixture("business.storage_credit")),
  "GET /v1/api_keys": ok(fixture("api_keys.list")),
  "GET /v1/webhook_endpoints": ok(fixture("webhook_endpoints.list")),
  "GET /v1/cashouts": ok({ data: [] }),
  "GET /v1/statements": ok(fixture("statements.get")),
});

test("a sidebar click the router never answers still goes to the page (it left people on the old page until they reloaded)", async ({
  page,
  context,
}) => {
  await signIn(context);
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockApi(page, handlers());
  await page.goto("/app");
  // The router's own requests for the next page hang for ever.
  await page.route(
    (url) => url.search.includes("_rsc="),
    () => undefined,
  );
  await page.getByRole("link", { name: "Invoices", exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\/invoices$/, { timeout: 8000 });
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 10000 });
});

test("sidebar navigation moves between pages without a reload", async ({ page, context }) => {
  await signIn(context);
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockApi(page, handlers());
  await page.goto("/app");
  const steps: [string, string][] = [
    ["Invoices", "/app/invoices"],
    ["Payments", "/app/payments"],
    ["Statements", "/app/statements"],
    ["Pay out", "/app/cashout"],
    ["Developers", "/app/developers"],
    ["Settings", "/app/settings"],
    ["Dashboard", "/app"],
    ["Invoices", "/app/invoices"],
  ];
  for (const [label, path] of steps) {
    await page.getByRole("link", { name: label, exact: true }).first().click();
    await expect(page, label).toHaveURL(new RegExp(path.replace("/", "\\/") + "$"), {
      timeout: 8000,
    });
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 8000 });
  }
});
