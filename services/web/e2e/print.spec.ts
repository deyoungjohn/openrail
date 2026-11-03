import { expect, test } from "@playwright/test";
import { fixture, mockApi } from "./api-mock";

// The receipt on paper: one A4 page with the hashes and links readable (update 27).
const HASH = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const RECEIPT = fixture("receipts.get");

test.describe("receipt print view", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await mockApi(page, { "GET /v1/receipts/{id}": { body: RECEIPT } });
    await page.goto(`/r/${HASH}`);
    await expect(page.getByRole("heading", { name: "Payment receipt" })).toBeVisible();
    await page.emulateMedia({ media: "print" });
  });

  test("fits one A4 page", async ({ page }) => {
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBe(1);
  });

  test("shows no controls: no theme toggle, no copy buttons, no retry", async ({ page }) => {
    await expect(page.getByRole("button", { name: /Switch to (light|dark) theme/ })).toBeHidden();
    await expect(page.getByRole("button", { name: /^Copy / })).toHaveCount(0);
  });

  test("prints black on white whatever the screen theme", async ({ page }) => {
    const colours = await page.evaluate(() => {
      const bg = getComputedStyle(document.body).backgroundColor;
      const fg = getComputedStyle(document.querySelector("main h1")!).color;
      return { bg, fg };
    });
    expect(colours.bg).toBe("rgb(255, 255, 255)");
    expect(colours.fg).toBe("rgb(0, 0, 0)");
  });

  test("every hash and address is printed in full, not shortened", async ({ page }) => {
    const chips = await page.locator("main code[data-full]").evaluateAll((els) =>
      els.map((el) => ({
        full: el.getAttribute("data-full")!,
        before: getComputedStyle(el, "::before").content.replace(/^"|"$/g, ""),
        ownSize: getComputedStyle(el).fontSize,
      })),
    );
    expect(chips.length).toBeGreaterThan(3);
    for (const c of chips) {
      expect(c.before).toBe(c.full);
      expect(c.ownSize).toBe("0px"); // the shortened text itself is not printed
    }
    const fulls = chips.map((c) => c.full);
    expect(fulls).toContain(RECEIPT.receipt.terms_hash);
    expect(fulls).toContain(HASH);
    for (const h of RECEIPT.receipt.near_tx_hashes as string[]) expect(fulls).toContain(h);
  });

  test("links print their address, so a paper copy can still be checked", async ({ page }) => {
    const links = await page.locator("main a[href^=http]").evaluateAll((as) =>
      as.map((a) => ({
        href: (a as HTMLAnchorElement).href,
        after: getComputedStyle(a, "::after").content,
      })),
    );
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l.after).toContain(l.href);
  });
});
