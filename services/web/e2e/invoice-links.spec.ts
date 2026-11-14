import { expect, test } from "@playwright/test";
import { fixture, mockApi } from "./api-mock";

// Invoice links are `/<business>/inv/<ref>`: the reference is the invoice's own random id, and the page finds the
// claim from it.
const claim = fixture("pay.claims.get");

test("the pay link finds the invoice by its reference", async ({ page }) => {
  await mockApi(page, {
    "GET /v1/pay/claims/{id}": () => ({ body: { ...claim, status: "Issued" } }),
  });
  await page.goto("/acme-ltd/inv/9f3c2a7d41b86e0c15");
  await expect(page.getByRole("button", { name: /^Pay with/ })).toBeVisible();
});

test("an unknown reference says so plainly", async ({ page }) => {
  await mockApi(page, {
    "GET /v1/pay/claims/{id}": () => ({
      status: 404,
      body: { error: { code: "invoice_not_found", message: "no such invoice" } },
    }),
  });
  await page.goto("/acme-ltd/inv/ffffffffffffffffff");
  await expect(page.getByText("We can't find this invoice")).toBeVisible();
});

test("an older pay link ending in /c/<claim id> opens the pay page", async ({ page }) => {
  await mockApi(page, {
    "GET /v1/pay/claims/{id}": () => ({ body: { ...claim, status: "Issued" } }),
  });
  await page.goto("/c/c-1");
  await expect(page).toHaveURL(/\/pay\/c-1$/);
});
