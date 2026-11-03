import { expect, test } from "@playwright/test";
import { fixture, mockApi, type Handlers } from "./api-mock";
import { axeClean } from "./setup-axe";
import { signIn } from "./helpers";

test.beforeEach(async ({ context }) => {
  await signIn(context);
});

const handlers = (): Handlers => ({
  "GET /v1/business": { body: fixture("business.get") },
  "PUT /v1/business": ({ body }) => ({ body: { ...fixture("business.get"), ...body } }),
  "GET /v1/business/storage_credit": { body: fixture("business.storage_credit") },
});

test("shows the profile and saves only what changed", async ({ page }) => {
  const calls = await mockApi(page, handlers());
  await page.goto("/app/settings");
  await expect(page.getByLabel("Business name")).toHaveValue("Acme Ltd");
  await expect(page.getByLabel("Payout account")).toHaveValue("acme.payout.near");
  await expect(page.getByLabel("Contact email")).toHaveValue("billing@example.com");
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await page.getByLabel("Business name").fill("Acme Studios Ltd");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  expect(calls.find((c) => c.key === "PUT /v1/business")!.body).toEqual({
    legal_name: "Acme Studios Ltd",
  });
});

test("a bad payout account or email is refused before anything is sent", async ({ page }) => {
  const calls = await mockApi(page, handlers());
  await page.goto("/app/settings");
  await page.getByLabel("Payout account").fill("Not An Account");
  await page.getByLabel("Contact email").fill("nope");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Enter a valid NEAR account")).toBeVisible();
  await expect(page.getByText("Enter a valid email address")).toBeVisible();
  expect(calls.filter((c) => c.key === "PUT /v1/business")).toHaveLength(0);
});

test("shows the storage credit and the signed-in account, and links to setup", async ({ page }) => {
  await mockApi(page, handlers());
  await page.goto("/app/settings");
  await expect(page.getByRole("region", { name: "Storage credit" })).toContainText("5 NEAR");
  await expect(page.getByRole("region", { name: "Signed in" })).toContainText("acme.openrail.near");
  await expect(page.getByRole("link", { name: "Open setup" })).toHaveAttribute(
    "href",
    "/app/onboarding",
  );
});

test("a failed save keeps the form and says nothing changed", async ({ page }) => {
  await mockApi(page, {
    ...handlers(),
    "PUT /v1/business": { status: 500, body: { error: { code: "internal", message: "x" } } },
  });
  await page.goto("/app/settings");
  await page.getByLabel("Business name").fill("Acme Studios Ltd");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("main [role=alert]")).toContainText("Nothing was changed");
  await expect(page.getByLabel("Business name")).toHaveValue("Acme Studios Ltd");
});

test("loading error", async ({ page }) => {
  await mockApi(page, {
    ...handlers(),
    "GET /v1/business": { status: 500, body: { error: { code: "internal", message: "x" } } },
  });
  await page.goto("/app/settings");
  await expect(page.locator("main [role=alert]").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" }).first()).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`360px, ${scheme}: no scroll, no WCAG AA violations`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await mockApi(page, handlers());
    await page.goto("/app/settings");
    await expect(page.getByLabel("Business name")).toHaveValue("Acme Ltd");
    await axeClean(page);
  });
}
