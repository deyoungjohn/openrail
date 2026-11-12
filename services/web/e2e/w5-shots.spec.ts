import { test } from "@playwright/test";
import { createHash } from "node:crypto";
import { fixture, mockApi } from "./api-mock";
import { signIn } from "./helpers";

// Run with SCREENSHOTS=1 to write the PR images to .next/e2e-screenshots/.
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1");

const CSV =
  "invoice_number,client,amount_due\nINV-2026-001,Debtor Co,12.50\nINV-2026-002,Northwind Studio,250.00\n";
const handlers = {
  "GET /v1/receipts/{id}": { body: fixture("receipts.get") },
  "GET /v1/statements": {
    body: {
      format: "csv",
      filename: "statement-2026-11-01-2026-11-30.csv",
      content_type: "text/csv",
      content_base64: Buffer.from(CSV).toString("base64"),
      sha256: `0x${createHash("sha256").update(CSV).digest("hex")}`,
      generated_at: "2026-11-02T10:10:00Z",
      from: "2026-11-01",
      to: "2026-11-30",
    },
  },
  "POST /v1/cashout/quote": {
    status: 201,
    body: {
      ...fixture("cashout.quote"),
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
  },
};

for (const scheme of ["light", "dark"] as const) {
  for (const width of [360, 1280]) {
    test(`receipt ${scheme} ${width}`, async ({ page }) => {
      await mockApi(page, handlers);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/r/0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.waitForTimeout(700);
      await page.screenshot({
        path: `.next/e2e-screenshots/w5-receipt-${scheme}-${width}.png`,
        fullPage: true,
      });
    });
    test(`statements ${scheme} ${width}`, async ({ page, context }) => {
      await signIn(context);
      await mockApi(page, handlers);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/app/statements");
      await page.getByLabel("From", { exact: true }).fill("2026-11-01");
      await page.getByLabel("To", { exact: true }).fill("2026-11-30");
      await page.getByRole("button", { name: "Get statement" }).click();
      await page.getByText("Fingerprint matches").waitFor();
      await page.waitForTimeout(700);
      await page.screenshot({
        path: `.next/e2e-screenshots/w5-statements-${scheme}-${width}.png`,
        fullPage: true,
      });
    });
    test(`cashout ${scheme} ${width}`, async ({ page, context }) => {
      await signIn(context);
      await mockApi(page, handlers);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/app/cashout");
      await page.getByLabel("Amount").fill("2");
      await page.getByLabel("Address").fill("0x53C5D39A5828BaDf817E40f22d75d96D731f8239");
      await page.getByRole("button", { name: "Get quote" }).click();
      await page.getByRole("button", { name: "Sign Payout" }).waitFor();
      await page.waitForTimeout(700);
      await page.screenshot({
        path: `.next/e2e-screenshots/w5-cashout-${scheme}-${width}.png`,
        fullPage: true,
      });
    });
  }
}
