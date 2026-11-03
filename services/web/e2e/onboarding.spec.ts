import { expect, test } from "@playwright/test";
import { fixture, mockApi, type Handlers } from "./api-mock";
import { axeClean } from "./setup-axe";
import { signIn } from "./helpers";

test.beforeEach(async ({ context }) => {
  await signIn(context);
});

const NEAR = 10n ** 24n;
const credit = (balance: bigint) => ({
  ...fixture("business.storage_credit"),
  balance: balance.toString(),
});
const notFound = { status: 404, body: { error: { code: "not_found", message: "no business" } } };

/** A stateful stand-in for the API: the business and credit change as the person completes steps. */
function world(initial: {
  business: Record<string, unknown> | null;
  balance: bigint;
  invoices: number;
}) {
  const s = { ...initial };
  const handlers: Handlers = {
    "GET /v1/business": () => (s.business ? { body: s.business } : notFound),
    "PUT /v1/business": ({ body }) => {
      s.business = {
        ...fixture("business.get"),
        legal_name: "",
        payout_account: "",
        contact_email: "",
        ...(s.business ?? {}),
        ...body,
      };
      return { body: s.business };
    },
    "GET /v1/business/storage_credit": () => ({ body: credit(s.balance) }),
    "GET /v1/invoices": () => ({
      body: {
        data: Array.from({ length: s.invoices }, () => fixture("invoices.list").data[0]),
        next_cursor: null,
      },
    }),
  };
  return { s, handlers };
}

test("a new business sees four steps and the first one open", async ({ page }) => {
  const { handlers } = world({ business: null, balance: 0n, invoices: 0 });
  await mockApi(page, handlers);
  await page.goto("/app/onboarding");
  const steps = page.getByRole("list", { name: "Setup steps" }).getByRole("listitem");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toContainText("Business profile");
  await expect(steps.nth(0)).toContainText("Next");
  await expect(page.getByLabel("Business name")).toBeVisible();
});

test("saving the profile sends exactly the two fields and marks the step done", async ({
  page,
}) => {
  const { handlers } = world({ business: null, balance: 0n, invoices: 0 });
  const calls = await mockApi(page, handlers);
  await page.goto("/app/onboarding");
  await page.getByLabel("Business name").fill("Acme Ltd");
  await page.getByLabel("Contact email").fill("ap@acme.example");
  await page.getByRole("button", { name: "Save profile" }).click();
  const steps = page.getByRole("list", { name: "Setup steps" }).getByRole("listitem");
  await expect(steps.nth(0)).toContainText("Done");
  await expect(steps.nth(1)).toContainText("Next");
  expect(calls.find((c) => c.key === "PUT /v1/business")!.body).toEqual({
    legal_name: "Acme Ltd",
    contact_email: "ap@acme.example",
  });
});

test("the payout account accepts a named or an implicit NEAR account and refuses anything else", async ({
  page,
}) => {
  const { handlers } = world({
    business: { ...fixture("business.get"), payout_account: "" },
    balance: 0n,
    invoices: 0,
  });
  const calls = await mockApi(page, handlers);
  await page.goto("/app/onboarding");
  const field = page.getByLabel("Payout account");
  await expect(field).toHaveValue("acme.openrail.near");
  await field.fill("Not An Account");
  await page.getByRole("button", { name: "Save payout account" }).click();
  await expect(page.getByText("Enter a valid NEAR account")).toBeVisible();
  expect(calls.filter((c) => c.key === "PUT /v1/business")).toHaveLength(0);

  const implicit = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";
  await field.fill(implicit);
  await page.getByRole("button", { name: "Save payout account" }).click();
  await expect(
    page.getByRole("list", { name: "Setup steps" }).getByRole("listitem").nth(1),
  ).toContainText("Done");
  expect(calls.find((c) => c.key === "PUT /v1/business")!.body).toEqual({
    payout_account: implicit,
  });
});

test("one deposit prepays the storage credit, and the first invoice is the last step", async ({
  page,
}) => {
  const w = world({ business: fixture("business.get"), balance: 0n, invoices: 0 });
  await mockApi(page, w.handlers);
  await page.goto("/app/onboarding");
  const steps = page.getByRole("list", { name: "Setup steps" }).getByRole("listitem");
  await expect(steps.nth(2)).toContainText("Next");
  w.s.balance = NEAR; // what the chain shows after the deposit
  await page.getByRole("button", { name: "Deposit storage credit" }).click();
  await expect(page.getByText("Deposit sent")).toBeVisible();
  await expect(steps.nth(2)).toContainText("Done");
  await expect(steps.nth(3)).toContainText("Next");
  await expect(page.getByRole("link", { name: "Create your first invoice" })).toHaveAttribute(
    "href",
    "/app/invoices/new",
  );
});

test("everything done says so", async ({ page }) => {
  const { handlers } = world({ business: fixture("business.get"), balance: NEAR, invoices: 2 });
  await mockApi(page, handlers);
  await page.goto("/app/onboarding");
  await expect(page.getByText("You're ready to get paid")).toBeVisible();
});

test("a failed load says so and retries", async ({ page }) => {
  let fail = true;
  const { handlers } = world({ business: fixture("business.get"), balance: NEAR, invoices: 1 });
  await mockApi(page, {
    ...handlers,
    "GET /v1/business": () =>
      fail
        ? { status: 500, body: { error: { code: "internal", message: "x" } } }
        : { body: fixture("business.get") },
  });
  await page.goto("/app/onboarding");
  await expect(page.locator("main [role=alert]").first()).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).first().click();
  await expect(page.getByText("You're ready to get paid")).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`360px, ${scheme}: no scroll, no WCAG AA violations`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const { handlers } = world({ business: null, balance: 0n, invoices: 0 });
    await mockApi(page, handlers);
    await page.goto("/app/onboarding");
    await expect(page.getByLabel("Business name")).toBeVisible();
    await axeClean(page);
  });
}
