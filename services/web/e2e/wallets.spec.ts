import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

test.describe("wallet picker (static cases in the gallery)", () => {
  test("sign-in lists wallets that can sign a message first, then the rest, in plain words", async ({
    page,
  }) => {
    await page.goto("/_dev/components");
    await page.getByRole("button", { name: "Open wallet picker" }).click();
    const dialog = page.getByRole("dialog");
    const headings = await dialog.getByRole("heading", { level: 3 }).allTextContents();
    expect(headings).toEqual([
      "Can sign you in",
      "Checking",
      "Cannot sign you in",
      "Not available on this device",
    ]);
    await expect(dialog.getByRole("button", { name: /Meteor Wallet/ })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: /OKX Wallet/ })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: /Coin98 Wallet/ })).toBeDisabled();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await dialog.getByRole("button", { name: /HOT Wallet/ }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "This wallet cannot sign you in. Use another wallet.",
    );
    await expect(dialog).toBeVisible();
  });
});

test.describe("implicit NEAR accounts (64 hex characters)", () => {
  const FULL = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";
  test("are middle-truncated with the full value in the tooltip and a copy button; named accounts are whole", async ({
    page,
  }) => {
    await page.goto("/_dev/components");
    await expect(page.getByText("acme.openrail.near", { exact: true })).toBeVisible();
    const truncated = page
      .locator(`code[title="${FULL}"]`)
      .filter({ hasText: "98793cd91a…f0dbd6de" });
    await expect(truncated).toBeVisible();
    await expect(page.getByRole("button", { name: /Copy 98793cd91a…f0dbd6de/ })).toBeVisible();
    await expect(page.locator(`code[title="${FULL}"]`).filter({ hasText: FULL })).toBeVisible();
  });
});

test.describe("what the selector says about each wallet", () => {
  test("every wallet gets a verdict, MyNearWallet is gone, and the table is written for the PR", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/_dev/wallets");
    const rows = page.getByTestId("capabilities").locator("tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    // Wait until probing has finished: no row is still "unknown" except wallets that cannot run here.
    await expect
      .poll(
        async () => {
          const all = await rows.evaluateAll((trs) =>
            trs.map((tr) => ({
              id: tr.querySelector("td:nth-child(2)")?.textContent ?? "",
              name: tr.querySelector("td:nth-child(1)")?.textContent ?? "",
              type: tr.querySelector("td:nth-child(3)")?.textContent ?? "",
              available: tr.querySelector('[data-field="available"]')?.textContent ?? "",
              signMessage: tr.querySelector('[data-field="signs"]')?.textContent ?? "",
            })),
          );
          return all.every((r) => r.signMessage !== "unknown" || r.available === "no")
            ? JSON.stringify(all)
            : "";
        },
        { timeout: 90_000 },
      )
      .not.toBe("");
    const table = await rows.evaluateAll((trs) =>
      trs.map((tr) => ({
        id: tr.querySelector("td:nth-child(2)")?.textContent ?? "",
        name: tr.querySelector("td:nth-child(1)")?.textContent ?? "",
        type: tr.querySelector("td:nth-child(3)")?.textContent ?? "",
        available: tr.querySelector('[data-field="available"]')?.textContent ?? "",
        signMessage: tr.querySelector('[data-field="signs"]')?.textContent ?? "",
      })),
    );
    mkdirSync(".next/e2e-results", { recursive: true });
    writeFileSync(".next/e2e-results/wallet-capabilities.json", JSON.stringify(table, null, 2));
    console.log("WALLET_CAPABILITIES " + JSON.stringify(table));

    const ids = table.map((r) => r.id);
    expect(ids.join(" ")).not.toMatch(/my-near-wallet|mynear/i);
    // Bitget's module does not start without its extension, so it is absent from the runtime list;
    // its capability is pinned statically in src/wallet/capabilities.test.ts.
    for (const id of ["meteor-wallet", "hot-wallet", "here-wallet", "okx-wallet", "coin98-wallet"])
      expect(ids).toContain(id);
    for (const r of table) expect(["yes", "no", "unknown"]).toContain(r.signMessage);
  });
});

// Run with SCREENSHOTS=1 to write the PR images to .next/e2e-screenshots/.
for (const scheme of ["light", "dark"] as const) {
  for (const width of [360, 1280]) {
    test(`screenshot wallet picker ${scheme} ${width}`, async ({ page }) => {
      test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1");
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/_dev/components");
      await page.getByRole("button", { name: "Open wallet picker" }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /HOT Wallet/ })
        .click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `.next/e2e-screenshots/wallet-picker-${scheme}-${width}.png` });
    });
  }
}
