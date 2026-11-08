import type { BrowserContext, Page } from "@playwright/test";

/** Fixture mode keeps its stand-in session in this cookie (see src/lib/auth.ts). */
export async function signIn(context: BrowserContext, account = "acme.openrail.near") {
  await context.addCookies([
    { name: "or_sess_mock", value: account, url: "http://127.0.0.1:3100" },
  ]);
}

/**
 * Choose a day on the three wheels of a date wheel field (year, then month, then day). The wheels start on the
 * earliest day offered, which is tomorrow (UTC), so the year index counts from tomorrow's year.
 */
export async function pickDate(page: Page, label: string, iso: string): Promise<void> {
  const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
  const firstYear = new Date(Date.now() + 86_400_000).getUTCFullYear();
  await page
    .getByRole("button", { name: new RegExp(`^${label}`) })
    .last()
    .click();
  const wheel = async (name: string, index: number) => {
    await page.getByRole("listbox", { name }).focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < index; i += 1) await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(400);
  };
  await wheel("Year", y - firstYear);
  await wheel("Month", m - 1);
  await wheel("Day", d - 1);
  await page.getByRole("button", { name: "Done" }).click();
}

/** Choose an option on a select (the motion select): open it by its label, then click the option. */
export async function choose(page: Page, label: string, option: string): Promise<void> {
  // While a tab morphs, the old panel is still in the page: the new one is the last.
  await page
    .getByRole("button", { name: new RegExp(`^${label}`) })
    .last()
    .click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** Choose a route on the pay page through its two selects: the token, then (if it has several) the network. */
export async function pickRoute(page: Page, route: string): Promise<void> {
  const [asset, chain] = route.split(" on ");
  await choose(page, "Pay with", asset as string);
  if (!chain) return;
  // A token with one network (SOL) has no second select: the route is picked by the first.
  const network = page.getByRole("button", { name: /^Network/ }).last();
  if (await network.isVisible({ timeout: 1500 }).catch(() => false))
    await choose(page, "Network", chain);
}
