import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const SIGNER = "0x53C5D39A5828BaDf817E40f22d75d96D731f8239";

/** A stand-in for an injected wallet (window.ethereum). It records what it was asked to sign. */
async function injectWallet(
  page: Page,
  opts: { chainIdHex?: string; code?: string; account?: string } = {},
) {
  await page.addInitScript(
    ({ chainIdHex, code, account }) => {
      const w = window as unknown as { __signed: unknown[]; ethereum: unknown };
      w.__signed = [];
      w.ethereum = {
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          switch (method) {
            case "eth_accounts":
            case "eth_requestAccounts":
              return [account];
            case "eth_chainId":
              return chainIdHex;
            case "eth_getCode":
              return code;
            case "eth_signTypedData_v4":
              w.__signed.push(JSON.parse((params as string[])[1] as string));
              return "0x" + "11".repeat(65);
            default:
              throw new Error(`unexpected ${method}`);
          }
        },
        on: () => {},
        removeListener: () => {},
      };
    },
    {
      chainIdHex: opts.chainIdHex ?? "0x2105",
      code: opts.code ?? "0x",
      account: opts.account ?? SIGNER,
    },
  );
}

test("every field is on the page before the wallet button (blueprint 2.7)", async ({ page }) => {
  await injectWallet(page);
  await page.goto("/ack/c-1");
  const main = page.getByRole("main");
  for (const text of ["INV-0001", "$1,250.00", "Acme Ltd", "Northwind Studio", "c-1.openrail.near"])
    await expect(main.getByText(text).first()).toBeVisible();
  await expect(main.getByText("Jan 16, 2027")).toBeVisible();
  await expect(
    main.getByText("0x82c0dd15895dbb114c0d7d0e04b1123d62ec5ddacfeec9d067df71555b03edea"),
  ).toBeVisible();
  const button = main.getByRole("button", { name: "Confirm with wallet" });
  await expect(button).toBeVisible();
  const fieldBox = await main.getByText("INV-0001").first().boundingBox();
  const buttonBox = await button.boundingBox();
  expect(fieldBox!.y).toBeLessThan(buttonBox!.y);
});

test("EVM debtor: the wallet is asked to sign exactly the fields on the page", async ({ page }) => {
  await injectWallet(page);
  await page.goto("/ack/c-1");
  await page.getByRole("button", { name: "Confirm with wallet" }).click();
  await expect(page.getByText("Accepted by client").first()).toBeVisible();
  // The way to pay is offered at once, not only a thank-you.
  await expect(page.getByRole("link", { name: "Pay this invoice" })).toHaveAttribute(
    "href",
    "/pay/c-1",
  );
  const signed = (await page.evaluate(
    () => (window as unknown as { __signed: unknown[] }).__signed,
  )) as {
    primaryType: string;
    domain: { chainId: number; name: string };
    message: Record<string, string>;
  }[];
  expect(signed).toHaveLength(1);
  expect(signed[0]!.primaryType).toBe("Acknowledge");
  expect(signed[0]!.domain.chainId).toBe(8453);
  expect(signed[0]!.message).toMatchObject({
    kind: "OPENRAIL_ACK_V1",
    rootContract: "openrail.near",
    tokenId: "c-1",
    termsHash: "0x82c0dd15895dbb114c0d7d0e04b1123d62ec5ddacfeec9d067df71555b03edea",
    amountDue: "1250000000",
    dueDate: "1800086400",
  });
});

test("EVM debtor: a different connected account is refused before signing", async ({ page }) => {
  await injectWallet(page, { account: "0x000000000000000000000000000000000000dEaD" });
  await page.goto("/ack/c-1");
  await page.getByRole("button", { name: "Confirm with wallet" }).click();
  await expect(page.locator("main [role=alert]")).toContainText("different account");
  expect(
    await page.evaluate(() => (window as unknown as { __signed: unknown[] }).__signed),
  ).toHaveLength(0);
});

test("EVM debtor: an unsupported chain and a contract wallet are refused in plain words", async ({
  page,
}) => {
  await injectWallet(page, { chainIdHex: "0x539" });
  await page.goto("/ack/c-1");
  await page.getByRole("button", { name: "Confirm with wallet" }).click();
  await expect(page.locator("main [role=alert]")).toContainText("Switch your wallet to");

  const page2 = await page.context().newPage();
  await injectWallet(page2, { code: "0x6080" });
  await page2.goto("/ack/c-1");
  await page2.getByRole("button", { name: "Confirm with wallet" }).click();
  await expect(page2.locator("main [role=alert]")).toContainText("smart-contract wallet");
});

test("no browser wallet: says what to do", async ({ page }) => {
  await page.goto("/ack/c-1");
  await expect(page.getByText("No browser wallet found")).toBeVisible();
});

test("NEAR debtor: names the account that must sign in", async ({ page }) => {
  await page.goto("/ack/c-2");
  await expect(page.getByText("northwind.near").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Sign in/ }).first()).toBeVisible();
});

test("already accepted, not found and error states", async ({ page }) => {
  await page.goto("/ack/c-3");
  await expect(page.getByText("Accepted by client").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm with wallet" })).toHaveCount(0);

  await page.goto("/ack/c-404");
  await expect(page.getByRole("heading", { name: "We can't find this invoice" })).toBeVisible();

  await page.goto("/ack/c-error");
  await expect(page.locator("main [role=alert]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  await page.goto("/ack/c-4");
  await expect(page.getByText("already paid")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm with wallet" })).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`ack page at 360px, ${scheme}: no scroll, no WCAG AA violations`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await injectWallet(page);
    await page.goto("/ack/c-1");
    await expect(page.getByRole("button", { name: "Confirm with wallet" })).toBeVisible();
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const r = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(r.violations).toEqual([]);
  });
}
