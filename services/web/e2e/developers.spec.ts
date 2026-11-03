import { expect, test } from "@playwright/test";
import { fixture, mockApi, type Handlers } from "./api-mock";
import { axeClean } from "./setup-axe";
import { signIn } from "./helpers";

test.beforeEach(async ({ context }) => {
  await signIn(context);
});

const base = (): Handlers => ({
  "GET /v1/api_keys": { body: fixture("api_keys.list") },
  "GET /v1/webhook_endpoints": { body: fixture("webhook_endpoints.list") },
  "GET /v1/webhook_endpoints/{id}/deliveries": { body: fixture("webhook_endpoints.deliveries") },
  "GET /v1/events": { body: fixture("events.list") },
});

test.describe("API keys", () => {
  test("lists keys by prefix with scopes, last use and status, never a secret", async ({
    page,
  }) => {
    await mockApi(page, base());
    await page.goto("/app/developers");
    const keys = page.getByRole("region", { name: "API keys" });
    await expect(keys).toContainText("Production");
    await expect(keys).toContainText("or_sk_live_ab12");
    await expect(keys).toContainText("invoices:read");
    await expect(keys).toContainText("Never used");
    await expect(keys).not.toContainText("secret");
  });

  test("creating a key shows the secret once, with a warning, and the list never shows it again", async ({
    page,
  }) => {
    let created = false;
    const calls = await mockApi(page, {
      ...base(),
      "POST /v1/api_keys": () => {
        created = true;
        return { status: 201, body: fixture("api_keys.create") };
      },
      "GET /v1/api_keys": () => ({
        body: created
          ? {
              data: [
                ...fixture("api_keys.list").data,
                {
                  ...fixture("api_keys.create"),
                  secret: undefined,
                  last_used_at: null,
                  revoked_at: null,
                },
              ],
            }
          : fixture("api_keys.list"),
      }),
    });
    await page.goto("/app/developers");
    await page.getByRole("button", { name: "Create key" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Key name").fill("CI");
    await dialog.getByRole("button", { name: "Create key" }).click();
    await expect(dialog.getByText("or_sk_live_example_shown_once")).toBeVisible();
    await expect(dialog.getByText("You won't see this key again")).toBeVisible();
    expect(calls.find((c) => c.key === "POST /v1/api_keys")!.body).toEqual({
      name: "CI",
      scopes: [
        "invoices:read",
        "invoices:write",
        "payments:read",
        "receipts:read",
        "webhooks:write",
      ],
    });
    await dialog.getByRole("button", { name: "I have copied it" }).click();
    await expect(page.getByText("or_sk_live_example_shown_once")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "API keys" })).toContainText("2 keys");
  });

  test("the scope picker offers the five secret-key scopes, all on, and sends only the ones left on", async ({
    page,
  }) => {
    const calls = await mockApi(page, {
      ...base(),
      "POST /v1/api_keys": { status: 201, body: fixture("api_keys.create") },
    });
    await page.goto("/app/developers");
    await page.getByRole("button", { name: "Create key" }).click();
    const dialog = page.getByRole("dialog");
    const boxes = dialog.getByRole("group", { name: "Scopes" }).getByRole("checkbox");
    await expect(boxes).toHaveCount(5);
    for (const name of [
      "invoices:read",
      "invoices:write",
      "payments:read",
      "receipts:read",
      "webhooks:write",
    ])
      await expect(dialog.getByRole("checkbox", { name })).toBeChecked();
    await dialog.getByLabel("Key name").fill("Read only");
    await dialog.getByRole("checkbox", { name: "invoices:write" }).uncheck();
    await dialog.getByRole("checkbox", { name: "webhooks:write" }).uncheck();
    await dialog.getByRole("button", { name: "Create key" }).click();
    await expect(dialog.getByText("or_sk_live_example_shown_once")).toBeVisible();
    expect(calls.find((c) => c.key === "POST /v1/api_keys")!.body).toEqual({
      name: "Read only",
      scopes: ["invoices:read", "payments:read", "receipts:read"],
    });
  });

  test("a key needs at least one scope", async ({ page }) => {
    const calls = await mockApi(page, {
      ...base(),
      "POST /v1/api_keys": { status: 201, body: fixture("api_keys.create") },
    });
    await page.goto("/app/developers");
    await page.getByRole("button", { name: "Create key" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Key name").fill("None");
    for (const name of [
      "invoices:read",
      "invoices:write",
      "payments:read",
      "receipts:read",
      "webhooks:write",
    ])
      await dialog.getByRole("checkbox", { name }).uncheck();
    await dialog.getByRole("button", { name: "Create key" }).click();
    await expect(dialog.getByText("Pick at least one scope")).toBeVisible();
    expect(calls.filter((c) => c.key === "POST /v1/api_keys")).toHaveLength(0);
  });

  test("rotating asks first, then shows the new secret once", async ({ page }) => {
    await mockApi(page, {
      ...base(),
      "POST /v1/api_keys/{id}/rotate": { body: fixture("api_keys.rotate") },
    });
    await page.goto("/app/developers");
    await page.getByRole("button", { name: "Rotate Production" }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText("The old key stops working");
    await confirm.getByRole("button", { name: "Rotate key" }).click();
    await expect(
      page.getByRole("dialog").getByText("or_sk_live_example_rotated_once"),
    ).toBeVisible();
  });

  test("revoking asks first and then removes the key", async ({ page }) => {
    let revoked = false;
    const calls = await mockApi(page, {
      ...base(),
      "DELETE /v1/api_keys/{id}": () => {
        revoked = true;
        return { body: { id: "key_01J00000000000000000000000", deleted: true } };
      },
      "GET /v1/api_keys": () => ({ body: revoked ? { data: [] } : fixture("api_keys.list") }),
    });
    await page.goto("/app/developers");
    await page.getByRole("button", { name: "Revoke Production" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Revoke key" }).click();
    await expect(page.getByText("No API keys yet")).toBeVisible();
    expect(calls.filter((c) => c.key === "DELETE /v1/api_keys/{id}")).toHaveLength(1);
  });

  test("empty and error states", async ({ page }) => {
    await mockApi(page, { ...base(), "GET /v1/api_keys": { body: { data: [] } } });
    await page.goto("/app/developers");
    await expect(page.getByText("No API keys yet")).toBeVisible();

    const p2 = await page.context().newPage();
    await mockApi(p2, {
      ...base(),
      "GET /v1/api_keys": { status: 500, body: { error: { code: "internal", message: "x" } } },
    });
    await p2.goto("/app/developers");
    await expect(
      p2.getByRole("region", { name: "API keys" }).getByRole("button", { name: "Try again" }),
    ).toBeVisible();
  });
});

test.describe("webhook endpoints", () => {
  test("lists endpoints with their events", async ({ page }) => {
    await mockApi(page, base());
    await page.goto("/app/developers");
    await page.getByRole("tab", { name: "Webhooks" }).click();
    const list = page.getByRole("region", { name: "Webhook endpoints" });
    await expect(list).toContainText("https://example.com/openrail/webhook");
    await expect(list).toContainText("invoice.paid");
  });

  test("creating one shows the signing secret once", async ({ page }) => {
    const calls = await mockApi(page, {
      ...base(),
      "POST /v1/webhook_endpoints": { status: 201, body: fixture("webhook_endpoints.create") },
    });
    await page.goto("/app/developers");
    await page.getByRole("tab", { name: "Webhooks" }).click();
    await page.getByRole("button", { name: "Add endpoint" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Endpoint URL").fill("https://example.com/openrail/webhook");
    await dialog.getByRole("checkbox", { name: "invoice.paid" }).check();
    await dialog.getByRole("button", { name: "Add endpoint" }).click();
    await expect(dialog.getByText("whsec_example_shown_once")).toBeVisible();
    await expect(dialog.getByText("You won't see this secret again")).toBeVisible();
    expect(calls.find((c) => c.key === "POST /v1/webhook_endpoints")!.body).toMatchObject({
      url: "https://example.com/openrail/webhook",
      events: ["invoice.paid"],
    });
  });

  test("refuses an endpoint without https or without an event", async ({ page }) => {
    const calls = await mockApi(page, {
      ...base(),
      "POST /v1/webhook_endpoints": { status: 201, body: fixture("webhook_endpoints.create") },
    });
    await page.goto("/app/developers");
    await page.getByRole("tab", { name: "Webhooks" }).click();
    await page.getByRole("button", { name: "Add endpoint" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Endpoint URL").fill("http://example.com/hook");
    await dialog.getByRole("button", { name: "Add endpoint" }).click();
    await expect(dialog.getByText("Use an https address")).toBeVisible();
    await expect(dialog.getByText("Pick at least one event")).toBeVisible();
    expect(calls.filter((c) => c.key === "POST /v1/webhook_endpoints")).toHaveLength(0);
  });

  test("a test event reports what the endpoint answered", async ({ page }) => {
    await mockApi(page, {
      ...base(),
      "POST /v1/webhook_endpoints/{id}/test": { body: fixture("webhook_endpoints.test") },
    });
    await page.goto("/app/developers");
    await page.getByRole("tab", { name: "Webhooks" }).click();
    await page.getByRole("button", { name: "Send test event" }).click();
    await expect(page.getByText("Delivered: your endpoint answered 200")).toBeVisible();

    await mockApi(page, {
      ...base(),
      "POST /v1/webhook_endpoints/{id}/test": {
        body: { delivered: false, status_code: 500, event_id: "evt_x" },
      },
    });
  });

  test("the delivery log shows status, attempt and time", async ({ page }) => {
    await mockApi(page, base());
    await page.goto("/app/developers");
    await page.getByRole("tab", { name: "Webhooks" }).click();
    await page.getByRole("button", { name: "Delivery log" }).click();
    const log = page.getByRole("dialog");
    await expect(log).toContainText("invoice.paid");
    await expect(log).toContainText("200");
    await expect(log).toContainText("Attempt 1");
  });

  test("deleting asks first", async ({ page }) => {
    const calls = await mockApi(page, {
      ...base(),
      "DELETE /v1/webhook_endpoints/{id}": {
        body: { id: "whe_01J00000000000000000000000", deleted: true },
      },
    });
    await page.goto("/app/developers");
    await page.getByRole("tab", { name: "Webhooks" }).click();
    await page.getByRole("button", { name: "Delete endpoint" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete endpoint" }).click();
    await expect
      .poll(() => calls.filter((c) => c.key === "DELETE /v1/webhook_endpoints/{id}").length)
      .toBe(1);
  });
});

test.describe("events", () => {
  test("lists events with their type and time", async ({ page }) => {
    await mockApi(page, base());
    await page.goto("/app/developers");
    await page.getByRole("tab", { name: "Events" }).click();
    const events = page.getByRole("region", { name: "Events" });
    await expect(events).toContainText("invoice.paid");
    await expect(events).toContainText("evt_01J00000000000000000000000");
  });

  test("empty", async ({ page }) => {
    await mockApi(page, { ...base(), "GET /v1/events": { body: { data: [], next_cursor: null } } });
    await page.goto("/app/developers");
    await page.getByRole("tab", { name: "Events" }).click();
    await expect(page.getByText("No events yet")).toBeVisible();
  });
});

for (const scheme of ["light", "dark"] as const) {
  test(`360px, ${scheme}: no scroll, no WCAG AA violations on every tab`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await mockApi(page, base());
    await page.goto("/app/developers");
    await expect(page.getByRole("region", { name: "API keys" })).toContainText("Production");
    await axeClean(page);
    await page.getByRole("tab", { name: "Webhooks" }).click();
    await expect(page.getByRole("region", { name: "Webhook endpoints" })).toContainText(
      "example.com",
    );
    await axeClean(page);
    await page.getByRole("tab", { name: "Events" }).click();
    await expect(page.getByRole("region", { name: "Events" })).toContainText("invoice.paid");
    await axeClean(page);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`create key dialog at 360px, ${scheme}: no WCAG AA violations`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await mockApi(page, base());
    await page.goto("/app/developers");
    await page.getByRole("button", { name: "Create key" }).click();
    await expect(page.getByRole("dialog").getByRole("group", { name: "Scopes" })).toBeVisible();
    await axeClean(page);
  });
}
