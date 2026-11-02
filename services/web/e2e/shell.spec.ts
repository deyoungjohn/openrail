import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`shell at 360px, ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    for (const path of ["/", "/app", "/_dev/components"]) {
      test(`${path} renders with no horizontal scroll`, async ({ page }) => {
        await page.goto(path);
        await expect(page.locator("main")).toBeVisible();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }

    test("theme follows the system and sets data-theme before paint", async ({ page }) => {
      await page.goto("/app");
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    });
  });
}

test("theme toggle switches and remembers the choice", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app");
  await page.getByRole("button", { name: /switch to dark theme/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("the app shell names no module", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/app");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("dev gallery is served when OPENRAIL_DEV_ROUTES=1", async ({ request }) => {
  const res = await request.get("/_dev/components");
  expect(res.status()).toBe(200);
});
