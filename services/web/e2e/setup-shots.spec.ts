import { test } from "@playwright/test";
import { fixture, mockApi } from "./api-mock";
import { signIn } from "./helpers";

// Run with SCREENSHOTS=1 to write the PR images to .next/e2e-screenshots/.
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1");

const handlers = {
  "GET /v1/business": { status: 404, body: { error: { code: "not_found", message: "x" } } },
  "GET /v1/business/storage_credit": {
    body: { ...fixture("business.storage_credit"), balance: "0" },
  },
  "GET /v1/invoices": { body: { data: [], next_cursor: null } },
  "GET /v1/api_keys": { body: fixture("api_keys.list") },
  "GET /v1/webhook_endpoints": { body: fixture("webhook_endpoints.list") },
  "GET /v1/events": { body: fixture("events.list") },
};
const settingsHandlers = {
  ...handlers,
  "GET /v1/business": { body: fixture("business.get") },
  "GET /v1/business/storage_credit": { body: fixture("business.storage_credit") },
};

for (const scheme of ["light", "dark"] as const) {
  for (const width of [360, 1280]) {
    for (const [slug, path, h] of [
      ["onboarding", "/app/onboarding", handlers],
      ["settings", "/app/settings", settingsHandlers],
      ["developers", "/app/developers", handlers],
    ] as const) {
      test(`${slug} ${scheme} ${width}`, async ({ page, context }) => {
        await signIn(context);
        await mockApi(page, h);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(path);
        await page.getByRole("heading", { level: 1 }).waitFor();
        await page.waitForTimeout(900);
        await page.screenshot({
          path: `.next/e2e-screenshots/setup-${slug}-${scheme}-${width}.png`,
          fullPage: true,
        });
      });
    }
  }
}
