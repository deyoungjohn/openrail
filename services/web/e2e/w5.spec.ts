import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { fixture, mockApi } from "./api-mock";
import { choose, signIn } from "./helpers";

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

const RECEIPT = fixture("receipts.get");
const HASH = RECEIPT.receipt.origin_tx.hash as string;

test.describe("receipt (public)", () => {
  const handlers = { "GET /v1/receipts/{id}": { body: RECEIPT } };

  test("shows what was paid, with every hash and the text that was agreed", async ({ page }) => {
    await mockApi(page, handlers);
    await page.goto(`/r/${HASH}`);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1, name: "Payment receipt" })).toBeVisible();
    await expect(main.getByText("12.50 USDC")).toBeVisible();
    await expect(main.getByText("Nov 2, 2026, 10:01 UTC")).toBeVisible();
    await expect(main.getByText("c-1", { exact: true })).toBeVisible();
    await expect(main.getByText(RECEIPT.receipt.terms_hash)).toBeVisible();
    await expect(main.getByText(RECEIPT.receipt.payment_instruction_v1)).toBeVisible();
    await expect(main.getByText("c-1.openrail.near")).toBeVisible();
  });

  test("the transactions link to their chain's explorer so anyone can check them", async ({
    page,
  }) => {
    await mockApi(page, handlers);
    await page.goto(`/r/${HASH}`);
    await expect(page.getByRole("link", { name: /View on explorer: 0xcccc…/ })).toHaveAttribute(
      "href",
      `https://basescan.org/tx/${HASH}`,
    );
    const near = RECEIPT.receipt.near_tx_hashes[0] as string;
    await expect(page.getByRole("link", { name: /View on explorer: 8cDysV/ })).toHaveAttribute(
      "href",
      `https://nearblocks.io/txns/${near}`,
    );
  });

  test("explains how to verify it yourself", async ({ page }) => {
    await mockApi(page, handlers);
    await page.goto(`/r/${HASH}`);
    await expect(page.getByRole("heading", { name: "Verify it yourself" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Receipt link" })).toBeVisible();
  });

  test("no receipt, and a failed load", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/receipts/{id}": {
        status: 404,
        body: { error: { code: "not_found", message: "x" } },
      },
    });
    await page.goto(`/r/${HASH}`);
    await expect(
      page.getByRole("heading", { name: "No receipt for this transaction" }),
    ).toBeVisible();

    const p2 = await page.context().newPage();
    await mockApi(p2, {
      "GET /v1/receipts/{id}": { status: 500, body: { error: { code: "internal", message: "x" } } },
    });
    await p2.goto(`/r/${HASH}`);
    await expect(p2.locator("main [role=alert]")).toBeVisible();
    await expect(p2.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`360px, ${scheme}: no scroll, no WCAG AA violations`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page, handlers);
      await page.goto(`/r/${HASH}`);
      await expect(page.getByText("12.50 USDC")).toBeVisible();
      await axeClean(page);
    });
  }
});

const CSV = 'invoice_number,amount_due\nINV-2026-001,12500000\nINV-2026-002,"2,000,000"\n';
const b64 = (s: string) => Buffer.from(s).toString("base64");
const sha = (s: string) => `0x${createHash("sha256").update(s).digest("hex")}`;
const statement = (over: Record<string, unknown> = {}) => ({
  format: "csv",
  filename: "statement-2026-11-01-2026-11-30.csv",
  content_type: "text/csv",
  content_base64: b64(CSV),
  sha256: sha(CSV),
  generated_at: "2026-11-02T10:10:00Z",
  from: "2026-11-01",
  to: "2026-11-30",
  ...over,
});

test.describe("statements", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  // The period comes from the date range picker: "This month" is one click and never goes backwards.
  async function request(page: Page) {
    await page.getByRole("button", { name: /Statement period/ }).click();
    await page.getByRole("button", { name: "This month" }).click();
    await page.getByRole("button", { name: "Get statement" }).click();
  }

  test("asks for the period and format, previews the CSV and checks its fingerprint", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const calls = await mockApi(page, { "GET /v1/statements": { body: statement() } });
    await page.goto("/app/statements");
    await request(page);
    const table = page.getByRole("table", { name: "Statement preview" });
    await expect(table.getByRole("columnheader", { name: "invoice_number" })).toBeVisible();
    await expect(table.getByRole("cell", { name: "INV-2026-001" })).toBeVisible();
    await expect(table.getByRole("cell", { name: "2,000,000" })).toBeVisible();
    await expect(page.getByText("Fingerprint matches")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Download statement-2026-11-01-2026-11-30\.csv/ }),
    ).toBeVisible();
    expect(calls.filter((c) => c.key === "GET /v1/statements")).toHaveLength(1);
  });

  test("a statement for one invoice sends its token id and says so", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const calls = await mockApi(page, {
      "GET /v1/statements": ({ url }) => ({
        body: statement({ token_id: url.searchParams.get("token_id") }),
      }),
    });
    await page.goto("/app/statements?token_id=c-1");
    await expect(page.getByText("This invoice only: c-1")).toBeVisible();
    await request(page);
    await expect(page.getByText("Fingerprint matches")).toBeVisible();
    expect(calls.filter((c) => c.key === "GET /v1/statements")).toHaveLength(1);
    await page.getByRole("button", { name: "Show all invoices" }).click();
    await expect(page.getByText("This invoice only: c-1")).toHaveCount(0);
  });

  test("without a token id the request is for the whole period", async ({ page }) => {
    let seen: string | null = "unset";
    await mockApi(page, {
      "GET /v1/statements": ({ url }) => {
        seen = url.searchParams.get("token_id");
        return { body: statement() };
      },
    });
    await page.goto("/app/statements");
    await request(page);
    await expect(page.getByText("Fingerprint matches")).toBeVisible();
    expect(seen).toBeNull();
  });

  test("warns when the fingerprint does not match the file", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/statements": { body: statement({ sha256: `0x${"b".repeat(64)}` }) },
    });
    await page.goto("/app/statements");
    await request(page);
    await expect(page.locator("main [role=alert]")).toContainText("doesn't match");
  });

  test("a PDF has no preview but can be downloaded", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/statements": {
        body: statement({ format: "pdf", filename: "s.pdf", content_type: "application/pdf" }),
      },
    });
    await page.goto("/app/statements");
    await choose(page, "Format", "PDF");
    await request(page);
    await expect(page.getByText("PDF statements have no preview")).toBeVisible();
    await expect(page.getByRole("link", { name: /Download s\.pdf/ })).toBeVisible();
  });

  test("an empty period and a failure are explained", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/statements": {
        body: statement({
          content_base64: b64("invoice_number,amount_due\n"),
          sha256: sha("invoice_number,amount_due\n"),
        }),
      },
    });
    await page.goto("/app/statements");
    await request(page);
    await expect(page.getByText("No payments in this period")).toBeVisible();

    // A backwards period cannot be chosen any more: the range picker puts the two dates in order.

    const p2 = await page.context().newPage();
    await mockApi(p2, {
      "GET /v1/statements": { status: 500, body: { error: { code: "internal", message: "x" } } },
    });
    await p2.goto("/app/statements");
    await p2.getByRole("button", { name: /Statement period/ }).click();
    await p2.getByRole("button", { name: "This month" }).click();
    await p2.getByRole("button", { name: "Get statement" }).click();
    await expect(p2.locator("main [role=alert]")).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`360px, ${scheme}: no scroll, no WCAG AA violations`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page, { "GET /v1/statements": { body: statement() } });
      await page.goto("/app/statements");
      await request(page);
      await expect(page.getByText("Fingerprint matches")).toBeVisible();
      await axeClean(page);
    });
  }
});

test.describe("cash out", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });
  const ADDR = "0x53C5D39A5828BaDf817E40f22d75d96D731f8239";
  const quote = (over: Record<string, unknown> = {}) => ({
    ...fixture("cashout.quote"),
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...over,
  });

  async function ask(page: Page, amount = "2", chain = "Base", address = ADDR) {
    await page.getByLabel("Amount").fill(amount);
    await choose(page, "Send to", chain);
    await page.getByLabel("Address").fill(address);
    await page.getByRole("button", { name: "Get quote" }).click();
  }

  test("the route cost comes before the sign button, as a share of the amount", async ({
    page,
  }) => {
    const calls = await mockApi(page, { "POST /v1/cashout/quote": { status: 201, body: quote() } });
    await page.goto("/app/cashout");
    await ask(page);
    const cost = page.getByRole("region", { name: "What it costs" });
    await expect(cost).toContainText("$0.30");
    await expect(cost).toContainText("15.0% of this cash-out");
    await expect(cost).toContainText("You receive exactly");
    await expect(cost).toContainText("1.998 USDC");
    await expect(cost).toContainText(
      "Up to 1% extra is held while the cash-out runs, and comes back to you.",
    );
    expect(calls.find((c) => c.key === "POST /v1/cashout/quote")!.body).toEqual({
      amount: "2000000",
      destination_chain: "base",
      address: ADDR,
    });
    const sign = page.getByRole("button", { name: "Sign cash out" });
    const a = (await cost.boundingBox())!;
    const b = (await sign.boundingBox())!;
    expect(a.y).toBeLessThan(b.y);
  });

  test("signing sends the cash-out (fixture mode)", async ({ page }) => {
    await mockApi(page, { "POST /v1/cashout/quote": { status: 201, body: quote() } });
    await page.goto("/app/cashout");
    await ask(page);
    await page.getByRole("button", { name: "Sign cash out" }).click();
    await expect(page.getByText("Cash-out sent")).toBeVisible();
  });

  test("BNB Chain is not offered, and a bad address or amount sends nothing", async ({ page }) => {
    const calls = await mockApi(page, { "POST /v1/cashout/quote": { status: 201, body: quote() } });
    await page.goto("/app/cashout");
    await expect(page.getByLabel("Send to").locator("option")).toHaveText([
      "Base",
      "Arbitrum",
      "Optimism",
      "Polygon",
      "Solana",
      "Ethereum",
      "NEAR",
    ]);
    await ask(page, "0", "Base", "0x123");
    await expect(page.getByText("Enter an amount")).toBeVisible();
    await expect(page.getByText("starts with 0x")).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  test("an expired quote is never signed", async ({ page }) => {
    await mockApi(page, {
      "POST /v1/cashout/quote": {
        status: 201,
        body: quote({ deadline: new Date(Date.now() - 1000).toISOString() }),
      },
    });
    await page.goto("/app/cashout");
    await ask(page);
    await expect(page.getByText("This quote expired")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign cash out" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Get a new quote" })).toBeVisible();
  });

  test("a failed quote says nothing was charged", async ({ page }) => {
    await mockApi(page, {
      "POST /v1/cashout/quote": {
        status: 500,
        body: { error: { code: "internal", message: "x" } },
      },
    });
    await page.goto("/app/cashout");
    await ask(page);
    await expect(page.locator("main [role=alert]")).toContainText("Nothing was charged");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`360px, ${scheme}: no scroll, no WCAG AA violations`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page, { "POST /v1/cashout/quote": { status: 201, body: quote() } });
      await page.goto("/app/cashout");
      await ask(page);
      await expect(page.getByRole("button", { name: "Sign cash out" })).toBeVisible();
      await axeClean(page);
    });
  }
});
