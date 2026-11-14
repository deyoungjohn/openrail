import { test } from "@playwright/test";
import { signIn } from "./helpers";

// Run with SCREENSHOTS=1 to write the PR images to .next/e2e-screenshots/.
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1");

for (const scheme of ["light", "dark"] as const) {
  for (const [name, width] of [
    ["360", 360],
    ["1280", 1280],
  ] as const) {
    for (const [slug, path] of [
      ["app", "/app"],
      ["gallery", "/_dev/components"],
      ["transfer", "/app/invoices/c-3/transfer"],
    ] as const) {
      test(`${slug} ${scheme} ${name}`, async ({ page, context }) => {
        await signIn(context);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(path);
        await page.getByRole("heading", { level: 1 }).waitFor(); // fixture data has loaded
        await page.waitForTimeout(600); // theme toggle mounts and transitions settle
        await page.screenshot({
          path: `.next/e2e-screenshots/${slug}-${scheme}-${name}.png`,
          fullPage: true,
        });
      });
    }
  }
}
