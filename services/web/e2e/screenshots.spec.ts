import { test } from "@playwright/test";

// Run with SCREENSHOTS=1 to write the PR images to screenshots/.
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1");

for (const scheme of ["light", "dark"] as const) {
  for (const [name, width] of [
    ["360", 360],
    ["1280", 1280],
  ] as const) {
    for (const [slug, path] of [
      ["app", "/app"],
      ["gallery", "/_dev/components"],
    ] as const) {
      test(`${slug} ${scheme} ${name}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(path);
        await page.screenshot({
          path: `screenshots/${slug}-${scheme}-${name}.png`,
          fullPage: true,
        });
      });
    }
  }
}
