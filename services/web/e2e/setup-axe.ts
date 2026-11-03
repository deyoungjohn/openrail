import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** No horizontal scroll and no WCAG AA violation on the current page. */
export async function axeClean(page: Page) {
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(r.violations).toEqual([]);
}
