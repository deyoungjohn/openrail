import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Fixture mode: the mock API keeps its "session" in a cookie so the flow behaves like the real
// HttpOnly cookie across reloads. The page itself never stores a token (checked below).

test("signed out: the dashboard is a preview with nothing in it, and only Sign in works", async ({
  page,
}) => {
  await page.goto("/app");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  // The layout is there (14 Nov: people want to see before they sign in) but nothing on it can be used.
  const preview = page.locator("[inert]");
  await expect(preview).toHaveCount(1);
  await expect(preview.getByText("Dashboard", { exact: true }).first()).toBeAttached();
  await expect(page.getByText("acme.openrail.near")).toHaveCount(0);
  // A click on the preview says why nothing happens, with a way to sign in right there.
  await page.getByTestId("preview-click-layer").click({ position: { x: 400, y: 300 } });
  const nudge = page.getByRole("status").filter({ hasText: "Sign in to use this" });
  await expect(nudge).toBeVisible();
  await nudge.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("acme.openrail.near").first()).toBeVisible();
});

test("sign in, reload, still signed in with no second prompt", async ({ page }) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("acme.openrail.near").first()).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
});

test("the page never keeps a session token in web storage", async ({ page }) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const stored = await page.evaluate(() =>
    JSON.stringify([
      ...Object.entries(window.localStorage),
      ...Object.entries(window.sessionStorage),
    ]).toLowerCase(),
  );
  expect(stored).not.toMatch(/sess|token/);
});

test("sign out ends the session, and it stays ended after a reload", async ({ page }) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("the session check failing shows an error with a retry, not a sign-in", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "or_sess_mock", value: "__error", url: "http://127.0.0.1:3100" },
  ]);
  await page.goto("/app");
  await expect(page.locator("main [role=alert]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
});

test("on a phone the account and sign out are in the menu", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/app");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Open menu" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("acme.openrail.near")).toBeVisible();
  await dialog.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
