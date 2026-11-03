import { test } from "@playwright/test";
import { fixture, mockApi } from "./api-mock";
import { signIn } from "./helpers";

// Run with SCREENSHOTS=1 to write the PR images to .next/e2e-screenshots/.
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1");

const DETAIL = fixture("invoices.get");
const handlers = {
  "GET /v1/payments": {
    body: {
      data: [
        {
          id: "p1",
          invoice_id: "i",
          amount: "12500000",
          origin_chain: "base",
          origin_asset: "a",
          status: "success",
          booked_at: "2026-10-03T10:00:00Z",
        },
        {
          id: "p2",
          invoice_id: "i",
          amount: "250000000",
          origin_chain: "arbitrum",
          origin_asset: "a",
          status: "success",
          booked_at: "2026-11-01T10:00:00Z",
        },
        {
          id: "p3",
          invoice_id: "i",
          amount: "40000000",
          origin_chain: "solana",
          origin_asset: "a",
          status: "success",
          booked_at: "2026-11-02T10:00:00Z",
        },
      ],
    },
  },
  "GET /v1/business": { body: fixture("business.get") },
  "GET /v1/business/storage_credit": { body: fixture("business.storage_credit") },
  "GET /v1/invoices": { body: fixture("invoices.list") },
  "GET /v1/invoices/{id}": {
    body: {
      invoice: { ...DETAIL.invoice, status: "PartiallyPaid" },
      claim: {
        ...DETAIL.claim,
        status: "PartiallyPaid",
        booked_total: "5000000",
        distributed_total: "4987500",
        fee_total: "12500",
      },
    },
  },
  "GET /v1/invoices/{id}/receipts": { body: fixture("invoices.receipts") },
  "GET /v1/invoices/{id}/open_quotes": { body: { data: [] } },
  "GET /v1/events": { body: fixture("events.list") },
};

for (const scheme of ["light", "dark"] as const) {
  for (const width of [360, 1280]) {
    for (const [slug, path] of [
      ["dashboard", "/app"],
      ["detail", "/app/invoices/inv_01J00000000000000000000000"],
      ["issue", "/app/invoices/new"],
    ] as const) {
      test(`${slug} ${scheme} ${width}`, async ({ page, context }) => {
        await signIn(context);
        await mockApi(page, handlers);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(path);
        await page.getByRole("heading", { level: 1 }).waitFor();
        await page.waitForTimeout(900);
        await page.screenshot({
          path: `.next/e2e-screenshots/w1-${slug}-${scheme}-${width}.png`,
          fullPage: true,
        });
      });
    }
  }
}
