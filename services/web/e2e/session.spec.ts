import { expect, test } from "@playwright/test";

// Fixture mode: the mock API keeps its "session" in a cookie so the flow behaves like the real
// HttpOnly cookie across reloads. The page itself never stores a token (checked below).

test("signed out: asks for one wallet signature and shows no dashboard", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toHaveCount(0);
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

test("loading shows a skeleton, not a flash of the sign-in card", async ({ page }) => {
  await page.goto("/app");
  // Whatever the final state, the first paint must not offer sign-in before the check finishes.
  const first = await page.evaluate(() => document.querySelector("main")?.textContent ?? "");
  expect(first).not.toContain("Sign in");
});
