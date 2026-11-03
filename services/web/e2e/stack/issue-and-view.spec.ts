import { expect, test } from "@playwright/test";
import { FullStackHarness } from "./harness.js";

test.describe("Full stack integration suite", () => {
  let harness: FullStackHarness;

  test.beforeAll(async () => {
    harness = new FullStackHarness();
    await harness.start();
  });

  test.afterAll(async () => {
    if (harness) {
      await harness.stop();
    }
  });

  test("issue an invoice through the issuer and see it on the dashboard", async ({
    page,
    context,
  }) => {
    const alice = harness.sandboxConfig.aliceAccountId;
    const bob = harness.sandboxConfig.bobAccountId;

    // 1. Issue an invoice through the real issuer service
    const invoiceNumber = "INV-STACK-001";
    const amountDue = "250000000"; // 250.00 USDC (6 decimals)
    const issued = await harness.issueInvoiceViaIssuer({
      business: alice,
      debtor: { Near: bob },
      amountDue,
      invoiceNumber,
    });

    expect(issued.tokenId).toBeTruthy();
    expect(issued.claimAccount).toContain(issued.tokenId);

    // 2. Set authenticated session cookie for Alice on the live API
    const sessionToken = harness.createSession(alice);
    await context.addCookies([
      {
        name: "or_sess",
        value: sessionToken,
        domain: "127.0.0.1",
        path: "/",
      },
      {
        name: "or_sess_mock",
        value: alice,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    // 3. Open dashboard at /app
    await page.goto(`http://127.0.0.1:${harness.webPort}/app`);

    // Verify the live dashboard loads for Alice
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText(alice).first()).toBeVisible();

    // Verify the invoice row appears in the dashboard invoice table
    const invoiceLink = page.getByRole("link", { name: invoiceNumber }).first();
    await expect(invoiceLink).toBeVisible();

    // Open invoice detail page and verify on-chain claim information
    await invoiceLink.click();
    await expect(page.getByText(issued.tokenId).first()).toBeVisible();
  });
});
