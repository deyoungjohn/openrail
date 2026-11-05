import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// DESIGN.md dark-mode rule (1): no glow, halo, bloom or box-shadow in either theme; blur only on .glass overlays.
for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });

    test("nothing on the component gallery has a shadow, blur or filter", async ({ page }) => {
      await page.goto("/_dev/components");
      await page.getByRole("button", { name: "Open modal" }).click();
      await page.getByRole("button", { name: "Show success toast" }).first().waitFor();
      const offenders = await page.evaluate(() => {
        const bad: string[] = [];
        for (const el of document.querySelectorAll("*")) {
          const cs = getComputedStyle(el);
          const hit = [
            // Pop-up glass has a soft edge shadow (liquid-glass-formula.md); nothing else may.
            cs.boxShadow !== "none" &&
              !el.classList.contains("glass") &&
              `box-shadow: ${cs.boxShadow}`,
            cs.textShadow !== "none" && `text-shadow: ${cs.textShadow}`,
            cs.filter !== "none" && `filter: ${cs.filter}`,
            // Blur is allowed on overlays only: dialogs, sheets, drawers and toasts carry the .glass class.
            cs.backdropFilter !== "none" &&
              !el.classList.contains("glass") &&
              `backdrop-filter: ${cs.backdropFilter}`,
          ].filter(Boolean);
          if (hit.length)
            bad.push(
              `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} ${hit.join(", ")}`,
            );
        }
        return bad;
      });
      expect(offenders).toEqual([]);
    });

    test("the focus ring is a solid 2px accent outline with a 2px offset", async ({ page }) => {
      await page.goto("/_dev/components");
      const button = page.getByRole("button", { name: "Send invoice" });
      await button.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      const ring = await button.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          style: cs.outlineStyle,
          width: cs.outlineWidth,
          offset: cs.outlineOffset,
          color: cs.outlineColor,
          accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
          shadow: cs.boxShadow,
        };
      });
      expect(ring).toMatchObject({ style: "solid", width: "2px", offset: "2px", shadow: "none" });
      const rgb = ring.accent
        .replace("#", "")
        .match(/../g)!
        .map((h) => parseInt(h, 16));
      expect(ring.color).toBe(`rgb(${rgb.join(", ")})`);
    });
  });
}

test("the active nav item has a 2px solid accent bar and no shadow", async ({ page, context }) => {
  await signIn(context);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app");
  const link = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Dashboard" });
  await expect(link).toHaveAttribute("aria-current", "page");
  const bar = await link.evaluate((el) => {
    const b = getComputedStyle(el, "::before");
    return { width: b.width, bg: b.backgroundColor, shadow: getComputedStyle(el).boxShadow };
  });
  expect(bar.width).toBe("2px");
  expect(bar.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(bar.shadow).toBe("none");
});
