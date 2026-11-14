import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "../../app.js";
import { AuthStore } from "../../auth.js";
import { expandEvents } from "../../modules.js";
import type { IndexedEvent } from "../../webhooks.js";
import type { CheckoutPort } from "./checkout-port.js";
import { createCheckoutApiModule } from "./index.js";
import type { PaymentLink } from "./payment-links.js";

const ACME = "acme.openrail.near";
const OTHER = "other.openrail.near";

function harness(options: { rateLimit?: number } = {}) {
  let now = new Date("2026-11-07T10:00:00Z");
  const clock = () => now;
  const auth = new AuthStore(() => clock().getTime());
  const key = (account: string, scopes: string[]) =>
    auth.createApiKey(account, "k", "secret", scopes).secret;
  const acme = key(ACME, ["invoices:read", "invoices:write"]);
  const acmeRead = key(ACME, ["invoices:read"]);
  const other = key(OTHER, ["invoices:read", "invoices:write"]);
  let n = 0;
  const create = vi.fn<CheckoutPort["create"]>(async (input) => {
    n += 1;
    return {
      checkout_id: `chk_${n}`,
      token_id: `c-${100 + n}`,
      pay_url: `https://pay.example/c/c-${100 + n}`,
      expires_at: new Date(clock().getTime() + input.expiryMinutes * 60_000).toISOString(),
    };
  });
  const module = createCheckoutApiModule({
    checkouts: () => ({ create }),
    ...(options.rateLimit === undefined ? {} : { defaultRateLimit: options.rateLimit }),
  });
  const deps: ApiDeps = {
    config: {
      rootAccount: "openrail.near",
      recipient: "api.openrail.near",
      payBaseUrl: "https://pay.example",
    },
    auth,
    issuer: {
      prepareIssue: vi.fn(),
      issueFor: vi.fn(),
      logQuote: vi.fn(),
      acknowledgeEvm: vi.fn(),
    },
    contract: { claim: vi.fn(), storageCredit: vi.fn() },
    accessKey: { has: async () => true },
    verifier: () => true,
    cashout: { quote: async () => ({}) },
    clock,
    modules: [module],
  };
  const app = new ApiApp(deps);
  return {
    app,
    module,
    create,
    keys: { acme, acmeRead, other },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

type H = ReturnType<typeof harness>;

function call(h: H, method: string, path: string, body?: unknown, secret?: string) {
  return h.app.handle({
    method,
    path,
    query: new URLSearchParams(),
    headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` },
    body,
  }) as Promise<{
    status: number;
    body: Record<string, unknown> & { error?: { code: string } };
    headers?: Record<string, string>;
  }>;
}

const fixed = {
  slug: "consult-1h",
  title: "One-hour consultation",
  amount: { type: "fixed", amount_usd: "150.00" },
};
const custom = { slug: "tip-jar", title: "Tip jar", amount: { type: "custom", min_usd: "5.00" } };

async function createLink(h: H, body: unknown = fixed, secret = h.keys.acme) {
  const response = await call(h, "POST", "/v1/payment_links", body, secret);
  return response as unknown as {
    status: number;
    body: PaymentLink & { error?: { code: string } };
  };
}

describe("payment links: API", () => {
  it("payment_link_create_returns_public_url_and_issues_nothing", async () => {
    const h = harness();
    const { status, body } = await createLink(h);
    expect(status).toBe(201);
    expect(body.id).toMatch(/^pl_[a-z0-9]{12}$/);
    expect(body.active).toBe(true);
    expect(body.public_path).toBe(`/l/${ACME}/consult-1h`);
    expect(body.rate_limit_per_hour).toBe(30);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("payment_link_slug_unique_per_business", async () => {
    const h = harness();
    expect((await createLink(h)).status).toBe(201);
    const again = await createLink(h);
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("slug_taken");
    expect((await createLink(h, fixed, h.keys.other)).status).toBe(201);
  });

  it("payment_link_validation", async () => {
    const h = harness();
    const bad: unknown[] = [
      { ...fixed, slug: "Has Space" },
      { ...fixed, slug: "x".repeat(65) },
      { ...fixed, title: "" },
      { ...fixed, amount: { type: "fixed", amount_usd: "0" } },
      { ...fixed, amount: { type: "fixed", amount_usd: "1.234" } },
      { ...fixed, amount: { type: "custom" } },
      { ...fixed, amount: { type: "custom", min_usd: "10.00", max_usd: "5.00" } },
      { ...fixed, image_url: "http://insecure.example/a.png" },
      { ...fixed, image_url: "javascript:alert(1)" },
      { ...fixed, quantity: { max: 0 } },
      { ...fixed, rate_limit_per_hour: 5000 },
    ];
    for (const body of bad) {
      const response = await createLink(h, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("payment_link_scopes_and_ownership", async () => {
    const h = harness();
    expect((await createLink(h, fixed, h.keys.acmeRead)).status).toBe(403);
    // No credentials: core refuses (401, or 403 for a cookie-less state-changing call).
    expect([401, 403]).toContain((await call(h, "POST", "/v1/payment_links", fixed)).status);
    const { body } = await createLink(h);
    expect(
      (await call(h, "GET", `/v1/payment_links/${body.id}`, undefined, h.keys.other)).status,
    ).toBe(404);
    expect(
      (await call(h, "PATCH", `/v1/payment_links/${body.id}`, { active: false }, h.keys.other))
        .status,
    ).toBe(404);
    const list = await call(h, "GET", "/v1/payment_links", undefined, h.keys.other);
    expect(list.body.data).toEqual([]);
    const mine = await call(h, "GET", "/v1/payment_links", undefined, h.keys.acmeRead);
    expect((mine.body.data as unknown[]).length).toBe(1);
  });

  it("payment_link_patch_activate_deactivate", async () => {
    const h = harness();
    const { body } = await createLink(h);
    const off = await call(
      h,
      "PATCH",
      `/v1/payment_links/${body.id}`,
      { active: false },
      h.keys.acme,
    );
    expect(off.body.active).toBe(false);
    const slug = await call(
      h,
      "PATCH",
      `/v1/payment_links/${body.id}`,
      { slug: "new" },
      h.keys.acme,
    );
    expect(slug.status).toBe(400);
    expect(slug.body.error?.code).toBe("immutable_field");
    const on = await call(
      h,
      "PATCH",
      `/v1/payment_links/${body.id}`,
      { active: true, title: "1h call" },
      h.keys.acme,
    );
    expect(on.body).toMatchObject({ active: true, title: "1h call" });
  });

  it("payment_link_public_view_has_no_owner_secrets", async () => {
    const h = harness();
    await createLink(h, { ...fixed, image_url: "https://img.example/a.png" });
    const view = await call(h, "GET", `/v1/public/payment_links/${ACME}/consult-1h`);
    expect(view.status).toBe(200);
    expect(Object.keys(view.body).sort()).toEqual(
      [
        "active",
        "amount",
        "business",
        "description",
        "id",
        "image_url",
        "quantity",
        "title",
      ].sort(),
    );
    expect((await call(h, "GET", `/v1/public/payment_links/${ACME}/nope`)).status).toBe(404);
  });
});

describe("payment links: sessions", () => {
  it("payment_link_creates_one_checkout_per_session", async () => {
    const h = harness();
    const { body: link } = await createLink(h);
    const a = await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, {});
    const b = await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, {});
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(a.body.pay_url).toBe("https://pay.example/c/c-101");
    expect(b.body.pay_url).toBe("https://pay.example/c/c-102");
    const first = h.create.mock.calls[0]?.[0];
    expect(first).toMatchObject({ accountId: ACME, amountUsd: "150.00", expiryMinutes: 60 });
    expect(first?.orderRef).toBe(`pl_${link.id.slice(3)}_${String(a.body.session_id).slice(3)}`);
    expect(first?.orderRef).not.toBe(h.create.mock.calls[1]?.[0].orderRef);
  });

  it("payment_link_fixed_amount_ignores_client_amount", async () => {
    const h = harness();
    const { body: link } = await createLink(h);
    await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, { amount_usd: "0.01" });
    expect(h.create.mock.calls[0]?.[0].amountUsd).toBe("150.00");
  });

  it("payment_link_quantity_multiplies_and_is_capped", async () => {
    const h = harness();
    const { body: link } = await createLink(h, { ...fixed, slug: "seats", quantity: { max: 3 } });
    await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, { quantity: 3 });
    expect(h.create.mock.calls[0]?.[0].amountUsd).toBe("450.00");
    expect(
      (await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, { quantity: 4 })).status,
    ).toBe(400);
    const noQty = (await createLink(h, { ...fixed, slug: "single" })).body;
    expect(
      (await call(h, "POST", `/v1/payment_links/${noQty.id}/sessions`, { quantity: 2 })).status,
    ).toBe(400);
  });

  it("payment_link_inactive_refuses_session", async () => {
    const h = harness();
    const { body: link } = await createLink(h);
    await call(h, "PATCH", `/v1/payment_links/${link.id}`, { active: false }, h.keys.acme);
    const response = await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, {});
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("payment_link_inactive");
    expect(h.create).not.toHaveBeenCalled();
    expect((await call(h, "POST", "/v1/payment_links/pl_doesnotexist/sessions", {})).status).toBe(
      404,
    );
  });

  it("payment_link_rate_limited", async () => {
    const h = harness({ rateLimit: 3 });
    const { body: link } = await createLink(h);
    for (let i = 0; i < 3; i += 1) {
      expect((await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, {})).status).toBe(201);
    }
    const limited = await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, {});
    expect(limited.status).toBe(429);
    expect(limited.body.error?.code).toBe("rate_limited");
    expect(Number(limited.headers?.["retry-after"])).toBeGreaterThan(0);
    expect(h.create).toHaveBeenCalledTimes(3);
    // Another link of the same business has its own budget.
    const other = (await createLink(h, { ...fixed, slug: "second" })).body;
    expect((await call(h, "POST", `/v1/payment_links/${other.id}/sessions`, {})).status).toBe(201);
    // The window slides: an hour later the first link works again.
    h.advance(60 * 60 * 1000 + 1);
    expect((await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, {})).status).toBe(201);
  });

  it("payment_link_custom_amount_min_enforced", async () => {
    const h = harness();
    const { body: link } = await createLink(h, {
      ...custom,
      amount: { type: "custom", min_usd: "5.00", max_usd: "500.00" },
    });
    for (const amount of [undefined, "4.99", "0", "-5", "abc", "5.001", "500.01"]) {
      const response = await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, {
        amount_usd: amount,
      });
      expect(response.status, String(amount)).toBe(400);
    }
    expect(h.create).not.toHaveBeenCalled();
    const ok = await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, { amount_usd: "5" });
    expect(ok.status).toBe(201);
    expect(h.create.mock.calls[0]?.[0].amountUsd).toBe("5.00");
  });

  it("payment_link_checkout_failure_reports_502_and_keeps_budget", async () => {
    const h = harness({ rateLimit: 1 });
    const { body: link } = await createLink(h);
    h.create.mockRejectedValueOnce(new Error("issuer down"));
    const failed = await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, {});
    expect(failed.status).toBe(502);
    expect(failed.body.error?.code).toBe("checkout_unavailable");
    expect((await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, {})).status).toBe(201);
  });
});

describe("payment links: payments and events", () => {
  async function paid(h: H) {
    const { body: link } = await createLink(h);
    const session = (await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, {})).body;
    const orderRef = h.create.mock.calls[0]?.[0].orderRef as string;
    const event = {
      id: "evt_9",
      type: "checkout_paid",
      created: 1_794_000_000,
      data: { token_id: "c-101", order_ref: orderRef, booked_total: "150000000" },
    } as unknown as IndexedEvent;
    return { link, session, event };
  }

  it("payment_link_paid_event_carries_link_id", async () => {
    const h = harness();
    const { link, session, event } = await paid(h);
    const out = expandEvents(event, h.app.modules, h.app.moduleContext);
    expect(out.map((e) => e.type)).toEqual(["checkout_paid", "payment_link.paid"]);
    expect(out[1]?.id).toBe("evt_9:payment_link.paid");
    expect(out[1]?.data).toMatchObject({
      payment_link_id: link.id,
      session_id: session.session_id,
      token_id: "c-101",
      booked_total: "150000000",
    });
    // Same for the API-style name; unrelated events pass through alone.
    expect(
      expandEvents(
        { ...event, type: "checkout.paid" } as IndexedEvent,
        h.app.modules,
        h.app.moduleContext,
      ),
    ).toHaveLength(2);
    const plain = {
      ...event,
      data: { token_id: "c-999", order_ref: "order-77" },
    } as unknown as IndexedEvent;
    expect(expandEvents(plain, h.app.modules, h.app.moduleContext)).toHaveLength(1);
  });

  it("payment_link_payments_lists_sessions_with_status", async () => {
    const h = harness();
    const { link, event } = await paid(h);
    expandEvents(event, h.app.modules, h.app.moduleContext);
    await call(h, "POST", `/v1/payment_links/${link.id}/sessions`, {});
    const response = await call(
      h,
      "GET",
      `/v1/payment_links/${link.id}/payments`,
      undefined,
      h.keys.acmeRead,
    );
    const rows = response.body.data as Array<{ status: string; token_id: string }>;
    expect(rows.map((r) => [r.token_id, r.status])).toEqual([
      ["c-101", "paid"],
      ["c-102", "open"],
    ]);
    expect(
      (await call(h, "GET", `/v1/payment_links/${link.id}/payments`, undefined, h.keys.other))
        .status,
    ).toBe(404);
  });

  it("payment_link_forged_order_ref_ignored", async () => {
    const h = harness();
    const { link, event } = await paid(h);
    // An order_ref that names the link but a session that does not exist, or a token that differs.
    const forged = {
      ...event,
      data: { ...event.data, order_ref: `pl_${link.id.slice(3)}_nosuchsession`, token_id: "c-555" },
    } as unknown as IndexedEvent;
    expect(expandEvents(forged, h.app.modules, h.app.moduleContext)).toHaveLength(1);
    const mismatch = {
      ...event,
      data: { ...event.data, token_id: "c-555" },
    } as unknown as IndexedEvent;
    expect(expandEvents(mismatch, h.app.modules, h.app.moduleContext)).toHaveLength(1);
  });
});
