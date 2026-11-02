import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fixture, mockApi } from "./api-mock";
import { signIn } from "./helpers";

test.beforeEach(async ({ context }) => {
  await signIn(context);
});

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const base = fixture("invoices.list").data[0];
const inv = (id: string, over: Record<string, unknown>) => ({
  ...base,
  id,
  token_id: id.replace("inv_", "c-"),
  invoice_number: id.replace("inv_", "INV-"),
  ...over,
});

const LIST = {
  data: [
    inv("inv_1", {
      status: "Paid",
      amount_usd: "250.50",
      debtor_legal_name: "Northwind Studio",
      due_date: day(-20),
    }),
    inv("inv_2", {
      status: "Issued",
      amount_usd: "100.00",
      debtor_legal_name: "Fabrikam Labs",
      due_date: day(10),
    }),
    inv("inv_3", {
      status: "Issued",
      amount_usd: "40.00",
      debtor_legal_name: "Fabrikam Labs",
      due_date: day(-3),
    }),
    inv("inv_4", {
      status: "Cancelled",
      amount_usd: "999.00",
      debtor_legal_name: "Contoso",
      due_date: day(5),
    }),
  ],
  next_cursor: null,
};

async function axeClean(page: Page) {
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

test.describe("dashboard", () => {
  test("shows exact totals, the status mix and the top clients", async ({ page }) => {
    await mockApi(page, { "GET /v1/invoices": { body: LIST } });
    await page.goto("/app");
    const main = page.getByRole("main");
    await expect(main.getByText("Outstanding")).toBeVisible();
    // 100.00 + 40.00 open; 250.50 paid; 40.00 overdue; the cancelled invoice is in no total.
    await expect(main.locator("p", { hasText: /^\$140\.00$/ }).first()).toBeVisible();
    await expect(main.locator("p", { hasText: /^\$250\.50$/ })).toBeVisible();
    await expect(main.locator("p", { hasText: /^\$40\.00$/ }).first()).toBeVisible();
    await expect(
      main.getByRole("img", { name: /Paid: 1, Waiting for payment: 1, Overdue: 1/ }),
    ).toBeVisible();
    const clients = main
      .getByRole("heading", { name: "Top clients" })
      .locator("xpath=ancestor::section");
    await expect(clients.getByText("Northwind Studio")).toBeVisible();
    await expect(clients.getByText("$250.50")).toBeVisible();
    await expect(clients.getByText("Contoso")).toHaveCount(0);
    await expect(main.getByRole("link", { name: "INV-1" })).toHaveAttribute(
      "href",
      "/app/invoices/inv_1",
    );
  });

  test("empty: invites the first invoice", async ({ page }) => {
    await mockApi(page, { "GET /v1/invoices": { body: { data: [], next_cursor: null } } });
    await page.goto("/app");
    await expect(page.getByText("No invoices yet")).toBeVisible();
    await expect(page.getByRole("link", { name: "Create invoice" }).first()).toHaveAttribute(
      "href",
      "/app/invoices/new",
    );
  });

  test("error: says so and retries", async ({ page }) => {
    let fail = true;
    await mockApi(page, {
      "GET /v1/invoices": () =>
        fail
          ? { status: 500, body: { error: { code: "internal", message: "x" } } }
          : { body: LIST },
    });
    await page.goto("/app");
    await expect(page.locator("main [role=alert]").first()).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Try again" }).first().click();
    await expect(page.getByRole("link", { name: "INV-1" })).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`360px, ${scheme}: no scroll, no WCAG AA violations`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page, { "GET /v1/invoices": { body: LIST } });
      await page.goto("/app");
      await expect(page.getByRole("link", { name: "INV-1" })).toBeVisible();
      await axeClean(page);
    });
  }
});

test.describe("invoices list", () => {
  test("tabs carry counts and filter the table", async ({ page }) => {
    await mockApi(page, { "GET /v1/invoices": { body: LIST } });
    await page.goto("/app/invoices");
    const tabs = page.getByRole("tablist", { name: "Invoice status" });
    await expect(tabs.getByRole("tab", { name: /All\s*4/ })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: /Paid\s*1/ })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: /Overdue\s*1/ })).toBeVisible();
    await tabs.getByRole("tab", { name: /Overdue/ }).click();
    await expect(page.getByRole("link", { name: "INV-3" })).toBeVisible();
    await expect(page.getByRole("link", { name: "INV-1" })).toHaveCount(0);
  });
});

const DETAIL = fixture("invoices.get");
const PAID_CLAIM = {
  ...DETAIL.claim,
  status: "PartiallyPaid",
  booked_total: "5000000",
  distributed_total: "4987500",
  fee_total: "12500",
  surplus: "0",
  credit_total: "0",
  ack: null,
};

test.describe("claim detail", () => {
  const handlers = {
    "GET /v1/invoices/{id}": {
      body: { invoice: { ...DETAIL.invoice, status: "PartiallyPaid" }, claim: PAID_CLAIM },
    },
    "GET /v1/invoices/{id}/receipts": { body: fixture("invoices.receipts") },
    "GET /v1/invoices/{id}/open_quotes": {
      body: {
        data: [
          {
            quote_id: "q1",
            deposit_address: "0xaaaabbbbccccddddeeeeffff0000111122223333",
            deadline_requested: Math.floor(Date.now() / 1000) + 600,
            refund_to: "0x1",
            route_id: "R1",
            expired: false,
          },
        ],
      },
    },
    "GET /v1/events": { body: fixture("events.list") },
  };

  test("every counter equals claim() exactly, with outstanding derived the blueprint way", async ({
    page,
  }) => {
    await mockApi(page, handlers);
    await page.goto("/app/invoices/inv_01J00000000000000000000000");
    const v = (k: string) => page.locator(`[data-counter="${k}"]`);
    await expect(v("amount_due")).toHaveText("$12.50");
    await expect(v("booked_total")).toHaveText("$5.00");
    await expect(v("distributed_total")).toHaveText("$4.987500");
    await expect(v("fee_total")).toHaveText("$0.012500");
    await expect(v("surplus")).toHaveText("$0.00");
    await expect(v("outstanding")).toHaveText("$7.50");
    await expect(page.getByText("Partially paid · $7.50 due")).toBeVisible();
  });

  test("shows payments with proof, open links, activity and the keyless account", async ({
    page,
  }) => {
    await mockApi(page, handlers);
    await page.goto("/app/invoices/inv_01J00000000000000000000000");
    await expect(page.getByText("Client's transaction")).toBeVisible();
    await expect(page.getByText("Payout transaction").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Open payment links" })).toBeVisible();
    await expect(page.getByText("invoice.paid")).toBeVisible();
    await expect(page.getByText("no keys", { exact: false })).toBeVisible();
    await expect(page.getByText("Not accepted yet")).toBeVisible();
    await expect(page.getByRole("link", { name: "Sell invoice" })).toHaveAttribute(
      "href",
      "/app/invoices/c-1/transfer",
    );
  });

  test("empty sections and a missing invoice", async ({ page }) => {
    await mockApi(page, {
      ...handlers,
      "GET /v1/invoices/{id}/receipts": { body: { data: [] } },
      "GET /v1/invoices/{id}/open_quotes": { body: { data: [] } },
      "GET /v1/events": { body: { data: [], next_cursor: null } },
    });
    await page.goto("/app/invoices/inv_01J00000000000000000000000");
    await expect(page.getByText("No payments yet")).toBeVisible();
    await expect(page.getByText("No open payment links").first()).toBeVisible();
    await expect(page.getByText("No activity yet")).toBeVisible();

    const p2 = await page.context().newPage();
    await mockApi(p2, {
      "GET /v1/invoices/{id}": {
        status: 404,
        body: { error: { code: "not_found", message: "x" } },
      },
    });
    await p2.goto("/app/invoices/nope");
    await expect(p2.getByRole("heading", { name: "We can't find this invoice" })).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`360px, ${scheme}: no scroll, no WCAG AA violations`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page, handlers);
      await page.goto("/app/invoices/inv_01J00000000000000000000000");
      await expect(page.getByText("Client's transaction")).toBeVisible();
      await axeClean(page);
    });
  }
});

test.describe("issue form", () => {
  const created = fixture("invoices.create");
  const handlers = {
    "GET /v1/business": { body: fixture("business.get") },
    "POST /v1/invoices": { status: 201, body: created },
    "POST /v1/invoices/{id}/send": { body: fixture("invoices.send") },
  };

  test("asks for what is missing, in plain words, and sends nothing", async ({ page }) => {
    const calls = await mockApi(page, handlers);
    await page.goto("/app/invoices/new");
    await page.getByRole("button", { name: "Create invoice" }).click();
    await expect(page.getByText("Enter your client's name.")).toBeVisible();
    await expect(page.getByText("Pick a due date.")).toBeVisible();
    expect(calls.filter((c) => c.key === "POST /v1/invoices")).toHaveLength(0);
  });

  test("the total is exact and a fraction of a cent is refused, not rounded", async ({ page }) => {
    await mockApi(page, handlers);
    await page.goto("/app/invoices/new");
    await page.getByLabel("Description").fill("Design");
    await page.getByLabel("Qty").fill("2");
    await page.getByLabel("Price").fill("10.10");
    await expect(page.getByTestId("issue-total")).toHaveText("$20.20");
    await page.getByLabel("Qty").fill("0.5");
    await page.getByLabel("Price").fill("0.01");
    await expect(page.getByTestId("issue-total")).toHaveText("—");
  });

  test("creates the invoice with the exact amount, then offers the pay link and email", async ({
    page,
  }) => {
    const calls = await mockApi(page, handlers);
    await page.goto("/app/invoices/new");
    await page.getByLabel("Client name").fill("Northwind Studio");
    await page.getByLabel("Client account", { exact: true }).fill("northwind.near");
    await page.getByLabel("Invoice number").fill("INV-0009");
    await page
      .getByLabel("Due date")
      .fill(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
    await page.getByLabel("Description").fill("Design");
    await page.getByLabel("Qty").fill("2");
    await page.getByLabel("Price").fill("125.00");
    await page.getByRole("button", { name: "Create invoice" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Invoice created" })).toBeVisible();
    await expect(dialog.getByText("Pay link", { exact: true })).toBeVisible();
    const post = calls.find((c) => c.key === "POST /v1/invoices")!;
    expect(post.body).toMatchObject({
      invoice_number: "INV-0009",
      issuer_legal_name: fixture("business.get").legal_name,
      debtor_legal_name: "Northwind Studio",
      debtor_key: "northwind.near",
      debtor_type: "near",
      amount_usd: "250.00",
      line_items: [{ description: "Design", quantity: 2, unit_amount_usd: "125.00" }],
    });

    await dialog.getByLabel("Client's email").fill("ap@northwind.example");
    await dialog.getByRole("button", { name: "Send invoice" }).click();
    await expect(dialog.getByText("Sent to ap@northwind.example")).toBeVisible();
  });

  test("a failed create says nothing was sent", async ({ page }) => {
    await mockApi(page, {
      ...handlers,
      "POST /v1/invoices": { status: 500, body: { error: { code: "internal", message: "x" } } },
    });
    await page.goto("/app/invoices/new");
    await page.getByLabel("Client name").fill("Northwind Studio");
    await page.getByLabel("Client account", { exact: true }).fill("northwind.near");
    await page.getByLabel("Invoice number").fill("INV-0009");
    await page
      .getByLabel("Due date")
      .fill(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
    await page.getByLabel("Description").fill("Design");
    await page.getByLabel("Price").fill("10.00");
    await page.getByRole("button", { name: "Create invoice" }).click();
    await expect(page.locator("main [role=alert]")).toContainText(
      "Nothing was sent to your client",
    );
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`360px, ${scheme}: no scroll, no WCAG AA violations`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page, handlers);
      await page.goto("/app/invoices/new");
      await expect(page.getByLabel("Client name")).toBeVisible();
      await axeClean(page);
    });
  }
});
