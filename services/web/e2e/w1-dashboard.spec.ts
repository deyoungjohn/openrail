import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fixture, mockApi } from "./api-mock";
import { pickDate, signIn } from "./helpers";

test.beforeEach(async ({ context }) => {
  await signIn(context);
});

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const base = fixture("invoices.list").data[0];
// USDC base units for an API amount like "250.50".
const units = (usd: string) => (BigInt(usd.replace(".", "")) * 10_000n).toString();
const inv = (id: string, over: Record<string, unknown>) => {
  const merged = {
    ...base,
    id,
    token_id: id.replace("inv_", "c-"),
    invoice_number: id.replace("inv_", "INV-"),
    ...over,
  } as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const paid = merged.status === "Paid";
  // Keep the SQ-10 fields consistent with the amount unless a test sets them.
  return {
    ...merged,
    outstanding: over.outstanding ?? (paid ? "0" : units(merged.amount_usd)),
    paid_total: over.paid_total ?? (paid ? units(merged.amount_usd) : "0"),
  };
};

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

const receipt = (id: string, usd: string, chain: string, time: string) => ({
  ...fixture("invoices.receipts").data[0],
  id,
  amount: units(usd),
  time,
  origin_tx: { chain, hash: `0x${id}`, sender: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
  booking_tx_hash: `0x${id}`,
});
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const RECEIPTS = {
  data: [
    receipt("r1", "100.00", "base", ago(1)),
    receipt("r2", "50.50", "solana", ago(2)),
    receipt("r3", "100.00", "base", ago(40)),
  ],
};

test.describe("dashboard", () => {
  test("shows the money that came in: revenue, activity, streams and top clients", async ({
    page,
  }) => {
    await mockApi(page, {
      "GET /v1/invoices": { body: LIST },
      "GET /v1/invoices/{id}/receipts": { body: RECEIPTS },
    });
    await page.goto("/app");
    const main = page.getByRole("main");
    await expect(main.getByRole("region", { name: "Monthly revenue" })).toBeVisible();
    await expect(main.getByRole("region", { name: "Weekly activity" })).toBeVisible();
    await expect(main.getByRole("region", { name: "Overview" })).toBeVisible();
    const activity = main.getByRole("region", { name: "Inflow" });
    await expect(activity.getByRole("cell", { name: "Northwind Studio" }).first()).toBeVisible();
    // The product column is hidden at 360 px; the row still carries who paid for what.
    await expect(activity.getByRole("row", { name: /Invoice INV-1/ }).first()).toBeVisible();
    // Streams: every receipt here is an invoice payment (250.50 in all).
    await expect(
      main.getByRole("img", { name: /Invoice: \$250\.50, Checkout: \$0\.00, Pay link: \$0\.00/ }),
    ).toBeVisible();
    const clients = main.getByRole("region", { name: "Top clients" });
    await expect(clients.getByText("Northwind Studio")).toBeVisible();
    await expect(clients.getByText("$250.50")).toBeVisible();
    // The totals (outstanding, collected, overdue) live on the invoices page now.
    await expect(main.getByText("Outstanding")).toHaveCount(0);
  });

  test("shows collections by month and where clients paid from, with time and stream filters", async ({
    page,
  }) => {
    await mockApi(page, {
      "GET /v1/invoices": { body: LIST },
      "GET /v1/invoices/{id}/receipts": { body: RECEIPTS },
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/app");
    const from = page.getByRole("region", { name: "Where clients paid from" });
    await expect(from).toContainText("Base");
    await expect(from).toContainText("$200.00");
    await expect(from).toContainText("Solana");
    await expect(from).toContainText("$50.50");
    await expect(from).not.toContainText("Ethereum");
    const months = page.getByRole("region", { name: "Collections by month" });
    // Two months, so no month row holds the whole $250.50 (the Total row does).
    await expect(
      months
        .getByRole("row")
        .filter({ hasNotText: "Total" })
        .getByRole("cell")
        .filter({ hasText: "$250.50" }),
    ).toHaveCount(0);

    // The last 7 days leave out the receipt from 40 days ago.
    await page
      .getByRole("button", { name: /^Time:/ })
      .last()
      .click();
    await page.getByRole("button", { name: "Last 7 days" }).click();
    await expect(from).toContainText("$100.00");
    await expect(from).not.toContainText("$200.00");

    // No checkout or pay link payments exist: the tables say so.
    await page
      .getByRole("group", { name: "Stream" })
      .last()
      .getByRole("button", { name: "Checkout" })
      .click();
    await expect(from).toContainText("No payments yet");
    await expect(months).toContainText("No payments yet");
  });

  test("no payments yet, and a failed load, are said plainly", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/invoices": { body: LIST },
      "GET /v1/invoices/{id}/receipts": { body: { data: [] } },
    });
    await page.goto("/app");
    await expect(page.getByRole("region", { name: "Inflow" })).toContainText("No payments yet");
    await expect(page.getByRole("region", { name: "Where clients paid from" })).toContainText(
      "No payments yet",
    );

    const p2 = await page.context().newPage();
    await mockApi(p2, {
      "GET /v1/invoices": { status: 500, body: { error: { code: "internal", message: "x" } } },
    });
    await p2.goto("/app");
    await expect(p2.getByRole("button", { name: "Try again" }).first()).toBeVisible();
  });

  test("empty: every card and chart is still there, and the balance opens the cash-out page", async ({
    page,
  }) => {
    await mockApi(page, { "GET /v1/invoices": { body: { data: [], next_cursor: null } } });
    await page.goto("/app");
    const main = page.getByRole("main");
    await expect(main.getByRole("region", { name: "Monthly revenue" })).toBeVisible();
    await expect(main.getByRole("region", { name: "Weekly activity" })).toBeVisible();
    await expect(main.getByRole("region", { name: "Overview" })).toBeVisible();
    await expect(main.getByRole("region", { name: "Top clients" })).toBeVisible();
    await expect(main.getByRole("region", { name: "Inflow" })).toBeVisible();
    await expect(main.getByText("No payments yet").first()).toBeVisible();
    // the balance button replaces "Create invoice" in the header and opens the cash-out page
    await expect(page.getByRole("link", { name: "Open the cash out page" })).toHaveAttribute(
      "href",
      "/app/cashout",
    );
  });

  test("error: says so and retries", async ({ page }) => {
    let fail = true;
    await mockApi(page, {
      "GET /v1/invoices": () =>
        fail
          ? { status: 500, body: { error: { code: "internal", message: "x" } } }
          : { body: LIST },
      "GET /v1/invoices/{id}/receipts": { body: RECEIPTS },
    });
    await page.goto("/app");
    await expect(page.locator("main [role=alert]").first()).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Try again" }).first().click();
    await expect(page.getByRole("region", { name: "Inflow" })).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`360px, ${scheme}: no scroll, no WCAG AA violations`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page, {
        "GET /v1/invoices": { body: LIST },
        "GET /v1/invoices/{id}/receipts": { body: RECEIPTS },
      });
      await page.goto("/app");
      await expect(page.getByRole("region", { name: "Inflow" })).toBeVisible();
      await axeClean(page);
    });
  }
});

test.describe("invoices list", () => {
  test("shows exact totals, the four cards and the invoices", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/invoices": { body: LIST },
      "GET /v1/invoices/{id}/receipts": { body: RECEIPTS },
    });
    await page.goto("/app/invoices");
    const main = page.getByRole("main");
    await expect(main.getByRole("region", { name: "Monthly revenue" })).toBeVisible();
    await expect(main.getByRole("region", { name: "Top clients" })).toBeVisible();
    await expect(main.getByText("Outstanding")).toBeVisible();
    // 100.00 + 40.00 open; 250.50 paid; 40.00 overdue; the cancelled invoice is in no total.
    await expect(main.locator("p", { hasText: /^\$140\.00$/ }).first()).toBeVisible();
    await expect(main.locator("p", { hasText: /^\$250\.50$/ })).toBeVisible();
    await expect(main.locator("p", { hasText: /^\$40\.00$/ }).first()).toBeVisible();
    await expect(main.getByRole("link", { name: "INV-1" })).toHaveAttribute(
      "href",
      "/app/invoices/inv_1",
    );
  });

  test("a partly paid invoice counts only what is still owed, from the API", async ({ page }) => {
    const partly = inv("inv_9", {
      status: "PartiallyPaid",
      amount_usd: "100.00",
      debtor_legal_name: "Half Co",
      due_date: day(10),
      outstanding: "40000000",
      paid_total: "60000000",
    });
    await mockApi(page, {
      "GET /v1/invoices": { body: { data: [partly], next_cursor: null } },
      "GET /v1/invoices/{id}/receipts": { body: { data: [] } },
    });
    await page.goto("/app/invoices");
    const main = page.getByRole("main");
    await expect(main.locator("p", { hasText: /^\$40\.00$/ }).first()).toBeVisible();
    await expect(main.locator("p", { hasText: /^\$60\.00$/ })).toBeVisible();
  });

  test("tabs carry counts and filter the table", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/invoices": { body: LIST },
      "GET /v1/invoices/{id}/receipts": { body: { data: [] } },
    });
    await page.goto("/app/invoices");
    const tabs = page.getByRole("tablist", { name: "Invoice status" });
    await expect(tabs.getByRole("tab", { name: /All\s*4/ })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: /Paid\s*1/ })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: /Overdue\s*1/ })).toBeVisible();
    await tabs.getByRole("tab", { name: /Overdue/ }).click();
    await expect(page.getByRole("link", { name: "INV-3" }).last()).toBeVisible();
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

  test("links to a statement for this invoice only", async ({ page }) => {
    await mockApi(page, handlers);
    await page.goto("/app/invoices/inv_01J00000000000000000000000");
    await expect(page.getByRole("link", { name: "Statement for this invoice" })).toHaveAttribute(
      "href",
      "/app/statements?token_id=c-1",
    );
  });

  test("each payment links to its public receipt by booking hash", async ({ page }) => {
    await mockApi(page, handlers);
    await page.goto("/app/invoices/inv_01J00000000000000000000000");
    await expect(page.getByRole("link", { name: "View receipt" })).toHaveAttribute(
      "href",
      "/r/0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
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
    "GET /v1/business/storage_credit": { body: fixture("business.storage_credit") },
    "POST /v1/invoices": { status: 201, body: created },
    "POST /v1/invoices/{id}/send": { body: fixture("invoices.send") },
  };

  test("shows the storage credit that pays for invoices", async ({ page }) => {
    await mockApi(page, handlers);
    await page.goto("/app/invoices/new");
    const credit = page.getByRole("region", { name: "Storage credit" });
    await expect(credit).toContainText("5 NEAR");
    await expect(credit.getByRole("button", { name: "Deposit storage credit" })).toHaveCount(0);
  });

  test("warns when the credit cannot cover an invoice and offers the deposit", async ({ page }) => {
    let balance = "0";
    await mockApi(page, {
      ...handlers,
      "GET /v1/business/storage_credit": () => ({
        body: { ...fixture("business.storage_credit"), balance },
      }),
    });
    await page.goto("/app/invoices/new");
    const credit = page.getByRole("region", { name: "Storage credit" });
    await expect(credit).toContainText("0 NEAR");
    await expect(credit).toContainText("don't have enough storage credit");
    balance = fixture("business.storage_credit").amount;
    await credit.getByRole("button", { name: "Deposit storage credit" }).click();
    await expect(credit.getByText("Deposit sent")).toBeVisible();
    await expect(credit).toContainText("1 NEAR");
    await expect(credit).not.toContainText("don't have enough storage credit");
  });

  test("an unreadable credit does not block the form", async ({ page }) => {
    await mockApi(page, {
      ...handlers,
      "GET /v1/business/storage_credit": {
        status: 500,
        body: { error: { code: "internal", message: "x" } },
      },
    });
    await page.goto("/app/invoices/new");
    await expect(page.getByRole("region", { name: "Storage credit" })).toContainText(
      "couldn't check",
    );
    await expect(page.getByRole("button", { name: "Create invoice" })).toBeEnabled();
  });

  test("asks for what is missing, in plain words, and sends nothing", async ({ page }) => {
    const calls = await mockApi(page, handlers);
    await page.goto("/app/invoices/new");
    await page.getByRole("button", { name: "Create invoice" }).click();
    await expect(page.getByText("Enter your client's name.")).toBeVisible();
    await expect(page.getByText("Pick a due date.")).toBeVisible();
    expect(calls.filter((c) => c.key === "POST /v1/invoices")).toHaveLength(0);
  });

  test("error text moves nothing on the page (hard rule)", async ({ page }) => {
    await mockApi(page, handlers);
    await page.goto("/app/invoices/new");
    const watched = [
      page.getByRole("button", { name: "Create invoice" }),
      page.getByLabel("Description"),
      page.getByLabel("Qty"),
      page.getByLabel("Price"),
      page.getByLabel("Invoice number"),
      page.getByLabel("Client name"),
    ];
    // Positions in the page, not the window: submitting scrolls the window.
    // Everything on the page has loaded (the storage credit card above the form changes height while it loads).
    await expect(page.locator("main .skeleton")).toHaveCount(0);
    const boxes = async () =>
      Promise.all(
        watched.map((l) =>
          l.evaluate((e) => {
            const r = e.getBoundingClientRect();
            return {
              x: Math.round(r.x + window.scrollX),
              y: Math.round(r.y + window.scrollY),
              w: Math.round(r.width),
              h: Math.round(r.height),
            };
          }),
        ),
      );
    const before = await boxes();
    await page.getByLabel("Price").fill("0");
    await page.getByRole("button", { name: "Create invoice" }).click();
    await expect(
      page.getByText("Use a quantity and a price that make a whole number of cents."),
    ).toBeVisible();
    expect(await boxes()).toEqual(before);
  });

  test("whole-number prices are accepted and typing keeps digits only", async ({ page }) => {
    await mockApi(page, handlers);
    await page.goto("/app/invoices/new");
    await page.getByLabel("Description").fill("Design");
    await page.getByLabel("Qty").fill("2");
    await page.getByLabel("Price").fill("1a0b");
    await expect(page.getByLabel("Price")).toHaveValue("10");
    await expect(page.getByText("$20.00").first()).toBeVisible();
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
    await pickDate(
      page,
      "Due date",
      new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
    );
    await page.getByLabel("Description").fill("Design");
    await page.getByLabel("Qty").fill("2");
    await page.getByLabel("Price").fill("125.00");
    await page.getByRole("button", { name: "Create invoice" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Invoice created" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Open invoice" })).toBeVisible();
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

    // Email is not available yet: the sheet offers the pay link and the QR code, and no email form.
    await expect(dialog.getByRole("button", { name: "Open invoice" })).toBeVisible();
    await expect(dialog.getByLabel("Client's email")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Send invoice" })).toHaveCount(0);
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
    await pickDate(
      page,
      "Due date",
      new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
    );
    await page.getByLabel("Description").fill("Design");
    await page.getByLabel("Price").fill("10.00");
    await page.getByRole("button", { name: "Create invoice" }).click();
    await expect(page.locator("main [role=alert]")).toContainText(
      "Nothing was sent to your client",
    );
  });

  test("no free invoices and no storage credit left says so, and points at the deposit", async ({
    page,
  }) => {
    await mockApi(page, {
      ...handlers,
      "POST /v1/invoices": {
        status: 402,
        body: { error: { code: "insufficient_storage_credit", message: "no credit" } },
      },
    });
    await page.goto("/app/invoices/new");
    await page.getByLabel("Client name").fill("Northwind Studio");
    await page.getByLabel("Client account", { exact: true }).fill("northwind.near");
    await page.getByLabel("Invoice number").fill("INV-0010");
    await pickDate(
      page,
      "Due date",
      new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
    );
    await page.getByLabel("Description").fill("Design");
    await page.getByLabel("Price").fill("10.00");
    await page.getByRole("button", { name: "Create invoice" }).click();
    await expect(page.locator("main [role=alert]")).toContainText("no storage credit left");
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
