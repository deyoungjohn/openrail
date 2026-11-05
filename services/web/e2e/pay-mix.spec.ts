import { expect, test, type Page } from "@playwright/test";
import { axeClean } from "./setup-axe";
import { fixture, mockApi, type Handlers } from "./api-mock";

// H9 pay mix ("Split this payment") and H10 pay without connecting a wallet, on the public pay page.

const REFUND = "0x53C5D39A5828BaDf817E40f22d75d96D731f8239";
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const units = (usd: string) => (BigInt(usd.replace(".", "")) * 10_000n).toString();

interface World {
  posts: { token_id: string; route_id: string; refund_to: string; amount_usd?: string }[];
  /** Status the poll answers, per session id. */
  status: Record<string, string>;
  /** Make the nth quote already expired. */
  expireQuote?: number;
}

/** A stand-in for the API with one claim of $12.50, the routes USDC on Base and on BNB Chain. */
function payApi(w: World, outstanding = "12500000"): Handlers {
  const claim = fixture("pay.claims.get");
  return {
    "GET /v1/pay/claims/{id}": () => ({ body: { ...claim, outstanding, status: "Issued" } }),
    "POST /v1/pay/sessions": ({ body }) => {
      w.posts.push(body);
      const n = w.posts.length;
      const usd = body.amount_usd ?? "12.50";
      return {
        status: 201,
        body: {
          ...fixture("pay.sessions.create"),
          id: `ps_${n}`,
          route_id: body.route_id,
          deposit_address: `0x${String(n).repeat(40)}`,
          amount_usd: usd,
          amount_in: units(usd),
          amount_out: units(usd),
          deadline:
            w.expireQuote === n ? new Date(Date.now() - 60_000).toISOString() : inMinutes(10),
        },
      };
    },
    "GET /v1/pay/sessions/{id}": ({ url }) => {
      const id = url.pathname.split("/").pop()!;
      return {
        body: { ...fixture("pay.sessions.status"), id, status: w.status[id] ?? "pending_deposit" },
      };
    },
  };
}

const world = (over: Partial<World> = {}): World => ({ posts: [], status: {}, ...over });

async function chooseAndGetPrice(page: Page, network: string, amount?: string) {
  await page.getByRole("button", { name: network }).click();
  await page.getByLabel("Refund address").fill(REFUND);
  if (amount !== undefined) await page.getByLabel("Amount for this part").fill(amount);
  await page.getByRole("button", { name: /^Get price/ }).click();
}

test.describe("H10: pay from any wallet or exchange, without connecting", () => {
  test("is the first tab, with the exchange fee warning and the refund rule up front", async ({
    page,
  }) => {
    await mockApi(page, payApi(world()));
    await page.goto("/pay/c-1");
    const tabs = page.getByRole("tablist", { name: "How you pay" });
    await expect(tabs.getByRole("tab").first()).toHaveText("Pay from any wallet or exchange");
    await expect(tabs.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
    await expect(tabs.getByRole("tab").nth(1)).toHaveText("Use a connected wallet");
    const panel = page.getByRole("tabpanel");
    await expect(panel).toContainText("Exchanges often take a withdrawal fee");
    await expect(panel).toContainText("refunded to that address and nowhere else");
  });

  test("no_connect_quote_requires_refund_address: no price, address or QR before a valid refund address", async ({
    page,
  }) => {
    const w = world();
    await mockApi(page, payApi(w));
    await page.goto("/pay/c-1");
    await page.getByRole("button", { name: "USDC on Base" }).click();
    // Nothing yet: no address field answer, no price.
    await expect(page.getByRole("region", { name: "Your price" })).toHaveCount(0);
    await page.getByRole("button", { name: "Get price" }).click();
    await expect(page.getByText("starts with 0x")).toBeVisible();
    await page.getByLabel("Refund address").fill("0xnotanaddress");
    await page.getByRole("button", { name: "Get price" }).click();
    expect(w.posts).toHaveLength(0);
    await expect(page.getByRole("region", { name: "Your price" })).toHaveCount(0);
    await expect(page.locator("main svg title")).toHaveCount(0);

    await page.getByLabel("Refund address").fill(REFUND);
    await page.getByRole("button", { name: "Get price" }).click();
    await expect(page.getByRole("region", { name: "Your price" })).toBeVisible();
    expect(w.posts).toEqual([{ token_id: "c-1", route_id: "R1", refund_to: REFUND }]);
    // The address, the QR code and the exact amount are all there.
    await expect(page.locator("code", { hasText: "0x1111" }).first()).toBeVisible();
    await expect(page.locator("main svg title").first()).toBeAttached();
    await expect(page.getByRole("region", { name: "Your price" })).toContainText("12.50 USDC");
  });

  test("the tab stays reachable with the keyboard: arrows move between the two tabs", async ({
    page,
  }) => {
    await mockApi(page, payApi(world()));
    await page.goto("/pay/c-1");
    const first = page.getByRole("tab", { name: "Pay from any wallet or exchange" });
    await first.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Use a connected wallet" })).toBeFocused();
    await expect(page.getByRole("tab", { name: "Use a connected wallet" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("the wallet tab fills in the refund address from a connected wallet", async ({ page }) => {
    await page.addInitScript((account) => {
      (window as unknown as { ethereum: unknown }).ethereum = {
        request: async ({ method }: { method: string }) =>
          method === "eth_accounts" || method === "eth_requestAccounts" ? [account] : null,
        on: () => {},
        removeListener: () => {},
      };
    }, REFUND);
    await mockApi(page, payApi(world()));
    await page.goto("/pay/c-1");
    await page.getByRole("tab", { name: "Use a connected wallet" }).click();
    await page.getByRole("button", { name: "USDC on Base" }).click();
    await expect(page.getByLabel("Refund address")).toHaveValue(REFUND);
  });

  test("the paste tab never fills in an address by itself", async ({ page }) => {
    await page.addInitScript((account) => {
      (window as unknown as { ethereum: unknown }).ethereum = {
        request: async ({ method }: { method: string }) =>
          method === "eth_accounts" || method === "eth_requestAccounts" ? [account] : null,
        on: () => {},
        removeListener: () => {},
      };
    }, REFUND);
    await mockApi(page, payApi(world()));
    await page.goto("/pay/c-1");
    await page.getByRole("button", { name: "USDC on Base" }).click();
    await expect(page.getByLabel("Refund address")).toHaveValue("");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`360px, ${scheme}: no scroll, no WCAG AA violations on both tabs`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page, payApi(world()));
      await page.goto("/pay/c-1");
      await page.getByRole("button", { name: "USDC on Base" }).click();
      await axeClean(page);
      await page.getByRole("tab", { name: "Use a connected wallet" }).click();
      await axeClean(page);
    });
  }
});

test.describe("H9: split this payment", () => {
  test("pay_mix_two_legs_books_paid: two parts on two networks cover the invoice", async ({
    page,
  }) => {
    const w = world();
    await mockApi(page, payApi(w));
    await page.goto("/pay/c-1");

    await page.getByRole("button", { name: "Split this payment" }).click();
    await chooseAndGetPrice(page, "USDC on Base", "5.00");
    expect(w.posts[0]).toEqual({
      token_id: "c-1",
      route_id: "R1",
      refund_to: REFUND,
      amount_usd: "5.00",
    });

    const parts = page.getByRole("region", { name: "Your payment so far" });
    await expect(parts).toContainText("Part 1");
    await expect(parts).toContainText("$5.00");
    await expect(parts).toContainText("Still to pay");
    await expect(parts).toContainText("$7.50");

    // The next part starts with what is left already filled in.
    await expect(page.getByLabel("Amount for this part")).toHaveValue("7.50");
    await chooseAndGetPrice(page, "USDC on BNB Chain");
    expect(w.posts[1]).toEqual({
      token_id: "c-1",
      route_id: "R6",
      refund_to: REFUND,
      amount_usd: "7.50",
    });
    await expect(parts).toContainText("Part 2");
    await expect(parts).toContainText("Every part is covered");
    await expect(parts).toContainText("$0.00");

    // Both parts arrive: the invoice is paid.
    w.status.ps_1 = "success";
    w.status.ps_2 = "success";
    await expect(page.getByText("All parts paid")).toBeVisible({ timeout: 20_000 });
  });

  test("each part has its own address and price, one under the other", async ({ page }) => {
    const w = world();
    await mockApi(page, payApi(w));
    await page.goto("/pay/c-1");
    await page.getByRole("button", { name: "Split this payment" }).click();
    await chooseAndGetPrice(page, "USDC on Base", "5.00");
    await chooseAndGetPrice(page, "USDC on BNB Chain");
    const prices = page.getByRole("region", { name: /^Your price/ });
    await expect(prices).toHaveCount(2);
    await expect(prices.nth(0)).toContainText("$5.00");
    await expect(prices.nth(1)).toContainText("$7.50");
    await expect(page.locator("code", { hasText: "0x1111" }).first()).toBeVisible();
    await expect(page.locator("code", { hasText: "0x2222" }).first()).toBeVisible();
  });

  test("a part's amount is checked before any price is requested", async ({ page }) => {
    const w = world();
    await mockApi(page, payApi(w));
    await page.goto("/pay/c-1");
    await page.getByRole("button", { name: "Split this payment" }).click();
    await page.getByRole("button", { name: "USDC on Base" }).click();
    await page.getByLabel("Refund address").fill(REFUND);
    for (const [amount, message] of [
      ["", "Enter an amount"],
      ["0", "Enter an amount"],
      ["1.234", "Enter an amount"],
      ["12.51", "more than what is left"],
    ] as const) {
      await page.getByLabel("Amount for this part").fill(amount);
      await page.getByRole("button", { name: "Get price for this part" }).click();
      await expect(page.getByText(message, { exact: false })).toBeVisible();
    }
    expect(w.posts).toHaveLength(0);
  });

  test("a part whose price expired, or that was refunded, gives its amount back", async ({
    page,
  }) => {
    const w = world({ expireQuote: 1 });
    await mockApi(page, payApi(w));
    await page.goto("/pay/c-1");
    await page.getByRole("button", { name: "Split this payment" }).click();
    await chooseAndGetPrice(page, "USDC on Base", "5.00");
    const parts = page.getByRole("region", { name: "Your payment so far" });
    // The first price was already out of date, so nothing is held back for it.
    await expect(parts).toContainText("$12.50");
    // A refunded part gives its amount back too.
    await page.getByRole("button", { name: "USDC on Base" }).click();
    await page.getByLabel("Amount for this part").fill("5.00");
    await page.getByRole("button", { name: "Get price for this part" }).click();
    await expect(parts).toContainText("$7.50");
    w.status.ps_2 = "refunded";
    await expect(parts).toContainText("$12.50", { timeout: 20_000 });
  });

  test("a failed price for a part says nothing was charged and keeps the parts so far", async ({
    page,
  }) => {
    const w = world();
    let down = false;
    const api = payApi(w);
    await mockApi(page, {
      ...api,
      "POST /v1/pay/sessions": (req) =>
        down
          ? { status: 500, body: { error: { code: "internal", message: "x" } } }
          : (api["POST /v1/pay/sessions"] as (r: typeof req) => never)(req),
    });
    await page.goto("/pay/c-1");
    await page.getByRole("button", { name: "Split this payment" }).click();
    await chooseAndGetPrice(page, "USDC on Base", "5.00");
    down = true;
    await chooseAndGetPrice(page, "USDC on BNB Chain");
    await expect(
      page.locator("main [role=alert]").filter({ hasText: "Nothing was charged" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Your payment so far" })).toContainText("Part 1");
  });

  test("a partly paid invoice starts with what is still owed", async ({ page }) => {
    await mockApi(page, payApi(world(), "4000000"));
    await page.goto("/pay/c-1");
    await page.getByRole("button", { name: "Split this payment" }).click();
    await page.getByRole("button", { name: "USDC on Base" }).click();
    await expect(page.getByLabel("Amount for this part")).toHaveValue("4.00");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`360px, ${scheme}: two parts, no scroll, no WCAG AA violations`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page, payApi(world()));
      await page.goto("/pay/c-1");
      await page.getByRole("button", { name: "Split this payment" }).click();
      await chooseAndGetPrice(page, "USDC on Base", "5.00");
      await expect(page.getByRole("region", { name: "Your payment so far" })).toBeVisible();
      await axeClean(page);
    });
  }
});
