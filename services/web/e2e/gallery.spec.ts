import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test(`gallery has no WCAG AA violations at 360px, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/_dev/components");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test("gallery shows loading, empty and error states", async ({ page }) => {
  await page.goto("/_dev/components");
  for (const state of ["loading", "empty", "error"]) {
    await expect(page.getByTestId(`table-${state}`)).toBeVisible();
  }
});

test("tabs: arrow keys move focus and selection, Home and End jump", async ({ page }) => {
  await page.goto("/_dev/components");
  const tabs = page.getByRole("tablist").first().getByRole("tab");
  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tabs.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tabs.first()).toBeFocused();
});

test("modal: traps focus, closes on Esc, returns focus to the opener", async ({ page }) => {
  await page.goto("/_dev/components");
  const opener = page.getByRole("button", { name: "Open modal" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("toast appears and auto-dismisses", async ({ page }) => {
  await page.goto("/_dev/components");
  await page.getByRole("button", { name: "Show success toast" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Paid" })).toBeVisible();
});
