import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApiApp, ApiError, type ApiDeps, type BusinessRecord } from "../../app.js";
import { AuthStore } from "../../auth.js";
import { expandEvents } from "../../modules.js";
import type { IndexedEvent } from "../../webhooks.js";
import type {
  CheckoutChain,
  ChainCheckoutState,
  LoggedQuote,
  RefundQuotePort,
} from "./checkouts.js";
import { computeFeeBreakdown } from "./checkouts.js";
import type { CheckoutPort } from "./checkout-port.js";
import { createCheckoutApiModule } from "./index.js";

const ACME = "acme.openrail.near";
const OTHER = "other.openrail.near";
const NOW = new Date("2026-11-10T10:00:00Z");
const PAYER_REFUND_TO = "0x1111111111111111111111111111111111111111";

interface FakeChain {
  claims: Map<string, Record<string, unknown>>;
  states: Map<string, ChainCheckoutState | null>;
  log: Map<string, LoggedQuote[]>;
}

function claimView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token_id: "c-101",
    kind: 1,
    amount_due: "2000000",
    booked_total: "0",
    surplus: "0",
    credit_total: "0",
    status: "Issued",
    claim_account: "c-101.claims.openrail.near",
    due_date: Math.floor(NOW.getTime() / 1000) + 900,
    ...overrides,
  };
}

function harness() {
  let now = new Date(NOW);
  const clock = () => now;
  const auth = new AuthStore(() => clock().getTime());
  const key = (account: string, scopes: string[]) =>
    auth.createApiKey(account, "k", "secret", scopes).secret;
  const keys = {
    acme: key(ACME, ["invoices:read", "invoices:write"]),
    acmeRead: key(ACME, ["invoices:read"]),
    other: key(OTHER, ["invoices:read", "invoices:write"]),
  };
  const chain: FakeChain = { claims: new Map(), states: new Map(), log: new Map() };
  let n = 0;
  const create = vi.fn<CheckoutPort["create"]>(async (input) => {
    n += 1;
    const token = `c-${100 + n}`;
    const expires = new Date(clock().getTime() + input.expiryMinutes * 60_000);
    chain.claims.set(
      token,
      claimView({
        token_id: token,
        claim_account: `${token}.claims.openrail.near`,
        due_date: Math.floor(expires.getTime() / 1000),
        amount_due: String(Math.round(Number(input.amountUsd) * 1_000_000)),
      }),
    );
    return {
      checkout_id: token,
      token_id: token,
      claim_account: `${token}.claims.openrail.near`,
      pay_url: `https://pay.example/c/${token}`,
      expires_at: expires.toISOString(),
    };
  });
  const fakeChain: CheckoutChain = {
    claim: async (token) => {
      const found = chain.claims.get(token);
      if (found === undefined) throw new Error("claim not found");
      return found;
    },
    checkoutState: async (token) => chain.states.get(token) ?? null,
    paymentLog: async (token) => chain.log.get(token) ?? [],
  };
  const refundQuote = vi.fn<RefundQuotePort["quote"]>(async (input) => ({
    quote_id: "rq_1",
    deposit_address: "deposit-near-addr",
    amount_in: input.amount === "2000000" ? "1990000" : input.amount,
    amount_out: input.amount,
    deadline: new Date(clock().getTime() + 600_000).toISOString(),
    recipient: input.refundTo,
  }));
  const module = createCheckoutApiModule({
    checkouts: () => ({ create }),
    chain: () => fakeChain,
    refunds: () => ({ quote: refundQuote }),
  });
  const issueFor = vi.fn();
  const deps: ApiDeps = {
    config: {
      rootAccount: "openrail.near",
      recipient: "api.openrail.near",
      payBaseUrl: "https://pay.example",
    },
    auth,
    issuer: { prepareIssue: vi.fn(), issueFor, logQuote: vi.fn(), acknowledgeEvm: vi.fn() },
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
    refundQuote,
    issueFor,
    keys,
    chain,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    context: () => app.moduleContext,
  };
}

type H = ReturnType<typeof harness>;
type Res = { status: number; body: Record<string, any>; headers?: Record<string, string> }; // eslint-disable-line @typescript-eslint/no-explicit-any

function call(
  h: H,
  method: string,
  path: string,
  body?: unknown,
  secret?: string,
  extra: Record<string, string> = {},
  query = new URLSearchParams(),
): Promise<Res> {
  return h.app.handle({
    method,
    path,
    query,
    headers: { ...(secret === undefined ? {} : { authorization: `Bearer ${secret}` }), ...extra },
    body,
  }) as Promise<Res>;
}

let idem = 0;
function createCheckout(h: H, body: Record<string, unknown> = {}, secret = h.keys.acme) {
  idem += 1;
  return call(
    h,
    "POST",
    "/v1/checkouts",
    { order_ref: "ORD-1", amount_usd: "2.00", ...body },
    secret,
    { "idempotency-key": `k-${idem}` },
  );
}

describe("checkout API: create", () => {
  it("checkout_create_returns_pay_url_expiry_and_claim_account", async () => {
    const h = harness();
    const { status, body } = await createCheckout(h);
    expect(status).toBe(201);
    expect(body.id).toBe("c-101");
    expect(body.pay_url).toBe("https://pay.example/c/c-101");
    expect(body.claim_account).toBe("c-101.claims.openrail.near");
    expect(body.status).toBe("pending");
    expect(body.expires_at).toBe("2026-11-10T10:15:00.000Z");
    expect(body.order_ref).toBe("ORD-1");
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0]?.[0]).toMatchObject({
      accountId: ACME,
      amountUsd: "2.00",
      orderRef: "ORD-1",
      expiryMinutes: 15,
    });
  });

  it("checkout_create_requires_idempotency_key", async () => {
    const h = harness();
    const response = await call(
      h,
      "POST",
      "/v1/checkouts",
      { order_ref: "A", amount_usd: "2.00" },
      h.keys.acme,
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("idempotency_key_required");
    expect(h.create).not.toHaveBeenCalled();
  });

  it("checkout_create_replay_with_same_key_returns_same_checkout", async () => {
    const h = harness();
    const body = { order_ref: "ORD-9", amount_usd: "2.00" };
    const headers = { "idempotency-key": "same" };
    const first = await call(h, "POST", "/v1/checkouts", body, h.keys.acme, headers);
    const second = await call(h, "POST", "/v1/checkouts", body, h.keys.acme, headers);
    expect(second.status).toBe(first.status);
    expect(second.body.id).toBe(first.body.id);
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("checkout_order_ref_unique_per_business", async () => {
    const h = harness();
    expect((await createCheckout(h)).status).toBe(201);
    const again = await createCheckout(h);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("order_ref_taken");
    expect(h.create).toHaveBeenCalledTimes(1);
    expect((await createCheckout(h, {}, h.keys.other)).status).toBe(201);
  });

  it("checkout_order_ref_freed_when_the_claim_fails", async () => {
    const h = harness();
    h.create.mockRejectedValueOnce(new ApiError(502, "issuer_unavailable"));
    expect((await createCheckout(h)).status).toBe(502);
    expect((await createCheckout(h)).status).toBe(201);
  });

  it("checkout_create_validation", async () => {
    const h = harness();
    const bad: Record<string, unknown>[] = [
      { order_ref: "" },
      { order_ref: "x".repeat(65) },
      { order_ref: "has space" },
      { amount_usd: "0" },
      { amount_usd: "0.00" },
      { amount_usd: "-1.00" },
      { amount_usd: "1.234" },
      { amount_usd: 2 },
      { amount_usd: "abc" },
      { expires_in_minutes: 0 },
      { expires_in_minutes: 61 },
      { expires_in_minutes: 1.5 },
      { expires_in_minutes: "15" },
      { return_url: "http://merchant.example/done" },
      { return_url: "javascript:alert(1)" },
      { return_url: "not a url" },
      { items: "nope" },
      { items: [1, 2] },
      { items: Array.from({ length: 101 }, () => ({ name: "x", quantity: 1 })) },
    ];
    for (const patch of bad) {
      const response = await createCheckout(h, patch);
      expect(response.status, JSON.stringify(patch)).toBe(400);
      expect(response.body.error.code).toBe("invalid_request");
    }
    const noRef = await call(h, "POST", "/v1/checkouts", { amount_usd: "2.00" }, h.keys.acme, {
      "idempotency-key": "x",
    });
    expect(noRef.status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("checkout_create_accepts_the_bounds_and_normalises_amount", async () => {
    const h = harness();
    expect((await createCheckout(h, { order_ref: "a", expires_in_minutes: 1 })).status).toBe(201);
    expect((await createCheckout(h, { order_ref: "b", expires_in_minutes: 60 })).status).toBe(201);
    const whole = await createCheckout(h, { order_ref: "c", amount_usd: "5" });
    expect(whole.status).toBe(201);
    expect(h.create.mock.calls[2]?.[0].amountUsd).toBe("5.00");
    const tenth = await createCheckout(h, { order_ref: "d", amount_usd: "5.5" });
    expect(tenth.status).toBe(201);
    expect(h.create.mock.calls[3]?.[0].amountUsd).toBe("5.50");
  });

  it("checkout_items_hashed_into_the_terms", async () => {
    const h = harness();
    const items = [{ name: "Coffee", quantity: 2, unit_price_usd: "1.00" }];
    await createCheckout(h, { items });
    const first = h.create.mock.calls[0]?.[0];
    expect(first?.itemsSha256).toBe(
      createHash("sha256")
        .update(JSON.stringify([{ name: "Coffee", quantity: 2, unit_price_usd: "1.00" }]))
        .digest("hex"),
    );
    await createCheckout(h, { order_ref: "ORD-2" });
    expect(h.create.mock.calls[1]?.[0].itemsSha256).toBe(
      createHash("sha256").update("[]").digest("hex"),
    );
  });

  it("checkout_create_needs_a_secret_key_with_write_scope", async () => {
    const h = harness();
    expect((await createCheckout(h, {}, h.keys.acmeRead)).status).toBe(403);
    const anonymous = await call(
      h,
      "POST",
      "/v1/checkouts",
      { order_ref: "A", amount_usd: "2.00" },
      "bad_secret",
    );
    expect(anonymous.status).toBe(401);
    const pub = h.app.moduleContext;
    void pub;
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe("checkout API: read the state from the claim", () => {
  async function made(h: H, body: Record<string, unknown> = {}) {
    const response = await createCheckout(h, body);
    return response.body.id as string;
  }
  const get = (h: H, id: string, secret = h.keys.acme) =>
    call(h, "GET", `/v1/checkouts/${id}`, undefined, secret);

  it("checkout_status_is_read_from_the_claim_never_from_the_record", async () => {
    const h = harness();
    const id = await made(h);
    expect((await get(h, id)).body.status).toBe("pending");
    // 1 USD booked: partial, and the amounts come from the claim
    h.chain.claims.set(id, {
      ...(h.chain.claims.get(id) ?? {}),
      booked_total: "1000000",
      status: "PartiallyPaid",
    });
    const partial = (await get(h, id)).body;
    expect(partial.status).toBe("partial");
    expect(partial.outstanding).toBe("1000000");
    expect(partial.paid_total).toBe("1000000");
    h.chain.claims.set(id, {
      ...(h.chain.claims.get(id) ?? {}),
      booked_total: "2000000",
      status: "Paid",
    });
    const paid = (await get(h, id)).body;
    expect(paid.status).toBe("paid");
    expect(paid.outstanding).toBe("0");
  });

  it("checkout_paid_only_on_full_amount", async () => {
    const h = harness();
    const id = await made(h);
    for (const booked of ["1", "1000000", "1999999"]) {
      h.chain.claims.set(id, { ...(h.chain.claims.get(id) ?? {}), booked_total: booked });
      expect((await get(h, id)).body.status).toBe("partial");
    }
    h.chain.claims.set(id, { ...(h.chain.claims.get(id) ?? {}), booked_total: "2000000" });
    expect((await get(h, id)).body.status).toBe("paid");
  });

  it("checkout_overpay_is_surplus_and_shown_separately", async () => {
    const h = harness();
    const id = await made(h);
    h.chain.claims.set(id, {
      ...(h.chain.claims.get(id) ?? {}),
      booked_total: "2500000",
      surplus: "500000",
    });
    const body = (await get(h, id)).body;
    expect(body.status).toBe("paid");
    expect(body.paid_total).toBe("2000000");
    expect(body.surplus).toBe("500000");
  });

  it("checkout_status_expired_late_accepted_refunded", async () => {
    const h = harness();
    const id = await made(h);
    h.advance(16 * 60_000);
    expect((await get(h, id)).body.status).toBe("expired");
    const expiry = Number(h.chain.claims.get(id)?.due_date);
    h.chain.claims.set(id, { ...(h.chain.claims.get(id) ?? {}), booked_total: "2000000" });
    h.chain.states.set(id, { expiry, late: true, refunded: false, order_ref: "ORD-1" });
    expect((await get(h, id)).body.status).toBe("late");
    h.chain.states.set(id, {
      expiry,
      late: true,
      refunded: false,
      accepted: true,
      order_ref: "ORD-1",
    });
    expect((await get(h, id)).body.status).toBe("accepted");
    h.chain.states.set(id, { expiry, late: true, refunded: true, order_ref: "ORD-1" });
    expect((await get(h, id)).body.status).toBe("refunded");
  });

  it("checkout_status_works_when_the_contract_has_no_checkout_state", async () => {
    // SQ-15: A checkout issued via `issue_for` with `kind = 1` has no `m:checkout:` record
    // before its first booking (`checkout_state` returns `null`), and every checkout method
    // falls back to `expiry = claim.due_date`. Verify `pending`, `partial`, `paid`, and `expired`.
    const h = harness();
    const id = await made(h);
    h.chain.states.set(id, null);

    // 1. Pending (booked_total = 0, before due_date)
    const pending = await get(h, id);
    expect(pending.body).toMatchObject({
      status: "pending",
      outstanding: "2000000",
      paid_total: "0",
    });
    expect((await call(h, "GET", `/v1/public/checkouts/${id}`)).body.status).toBe("pending");

    // 2. Partial (0 < booked_total < amount_due, before due_date)
    h.chain.claims.set(id, {
      ...(h.chain.claims.get(id) ?? {}),
      booked_total: "800000",
    });
    const partial = await get(h, id);
    expect(partial.body).toMatchObject({
      status: "partial",
      outstanding: "1200000",
      paid_total: "800000",
    });
    expect((await call(h, "GET", `/v1/public/checkouts/${id}`)).body.status).toBe("partial");

    // 3. Paid (booked_total >= amount_due, before due_date)
    h.chain.claims.set(id, {
      ...(h.chain.claims.get(id) ?? {}),
      booked_total: "2000000",
    });
    const paid = await get(h, id);
    expect(paid.body).toMatchObject({
      status: "paid",
      outstanding: "0",
      paid_total: "2000000",
    });
    expect((await call(h, "GET", `/v1/public/checkouts/${id}`)).body.status).toBe("paid");

    // 4. Expired (booked_total = 0, clock past claim.due_date)
    h.chain.claims.set(id, {
      ...(h.chain.claims.get(id) ?? {}),
      booked_total: "0",
    });
    h.advance(20 * 60_000);
    const expired = await get(h, id);
    expect(expired.body).toMatchObject({
      status: "expired",
      outstanding: "2000000",
      paid_total: "0",
    });
    expect((await call(h, "GET", `/v1/public/checkouts/${id}`)).body.status).toBe("expired");
  });

  it("checkout_flagged_state_maps_to_needs_attention", async () => {
    const h = harness();
    const id = await made(h);
    const expiry = Number(h.chain.claims.get(id)?.due_date);
    h.chain.claims.set(id, {
      ...(h.chain.claims.get(id) ?? {}),
      booked_total: "2000000",
    });
    h.chain.states.set(id, {
      expiry,
      late: true,
      refunded: false,
      accepted: false,
      order_ref: "ORD-1",
      notified: [`${id}:2000000`],
      held_amount: "1995000",
      flagged: true,
    });
    expect((await get(h, id)).body.status).toBe("needs_attention");
    expect((await call(h, "GET", `/v1/public/checkouts/${id}`)).body.status).toBe(
      "needs_attention",
    );
  });

  it("checkout_get_is_scoped_to_the_business", async () => {
    const h = harness();
    const id = await made(h);
    expect((await get(h, id, h.keys.other)).status).toBe(404);
    expect((await get(h, "c-999")).status).toBe(404);
    expect((await get(h, id, h.keys.acmeRead)).status).toBe(200);
  });

  it("checkout_list_is_paged_and_scoped", async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) await createCheckout(h, { order_ref: `O-${i}` });
    await createCheckout(h, { order_ref: "theirs" }, h.keys.other);
    const first = await call(
      h,
      "GET",
      "/v1/checkouts",
      undefined,
      h.keys.acme,
      {},
      new URLSearchParams({ limit: "2" }),
    );
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.has_more).toBe(true);
    const next = await call(
      h,
      "GET",
      "/v1/checkouts",
      undefined,
      h.keys.acme,
      {},
      new URLSearchParams({ limit: "10", cursor: String(first.body.next_cursor) }),
    );
    expect(next.body.data).toHaveLength(3);
    expect(next.body.has_more).toBe(false);
    const all = [...first.body.data, ...next.body.data].map(
      (row: { order_ref: string }) => row.order_ref,
    );
    expect(new Set(all).size).toBe(5);
    expect(all).not.toContain("theirs");
    for (const row of first.body.data) expect(row.status).toBe("pending");
  });

  it("checkout_public_view_needs_no_key_and_shows_no_internals", async () => {
    const h = harness();
    const id = await made(h, { return_url: "https://shop.example/thanks" });
    const view = await call(h, "GET", `/v1/public/checkouts/${id}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      id,
      order_ref: "ORD-1",
      amount_usd: "2.00",
      status: "pending",
      return_url: "https://shop.example/thanks",
      merchant: ACME,
      outstanding: "2000000",
    });
    expect(typeof view.body.expires_at).toBe("string");
    expect(typeof view.body.server_time).toBe("string");
    expect(Array.isArray(view.body.routes)).toBe(true);
    expect(view.body.routes.length).toBeGreaterThan(0);
    expect(Array.isArray(view.body.sessions)).toBe(true);
    const text = JSON.stringify(view.body);
    expect(text).not.toMatch(/idempotency|secret|items_sha256/i);
    expect((await call(h, "GET", "/v1/public/checkouts/nope")).status).toBe(404);
  });

  it("checkout_public_view_hides_return_url_until_paid_is_not_required", async () => {
    // The link is the merchant's own page; showing it before payment only helps the payer go back.
    const h = harness();
    const id = await made(h);
    const view = await call(h, "GET", `/v1/public/checkouts/${id}`);
    expect(view.body.return_url).toBeNull();
  });
});

describe("checkout API: no quote after expiry", () => {
  it("checkout_no_quote_after_expiry", async () => {
    const h = harness();
    const id = (await createCheckout(h)).body.id as string;
    h.advance(15 * 60_000);
    await expect(h.module.quoteWindow?.(id, h.context())).rejects.toMatchObject({
      status: 409,
      code: "checkout_expired",
    });
  });

  it("checkout_quote_deadline_is_the_expiry_not_later", async () => {
    const h = harness();
    const id = (await createCheckout(h)).body.id as string;
    h.advance(5 * 60_000);
    const window = await h.module.quoteWindow?.(id, h.context());
    expect(window).toEqual({ notAfter: Math.floor(NOW.getTime() / 1000) + 900 });
  });

  it("checkout_quote_window_ignores_other_tokens", async () => {
    const h = harness();
    await expect(h.module.quoteWindow?.("inv-1", h.context())).resolves.toBeUndefined();
  });

  it("checkout_quote_refused_when_already_paid", async () => {
    const h = harness();
    const id = (await createCheckout(h)).body.id as string;
    h.chain.claims.set(id, { ...(h.chain.claims.get(id) ?? {}), booked_total: "2000000" });
    await expect(h.module.quoteWindow?.(id, h.context())).rejects.toMatchObject({
      status: 409,
      code: "checkout_not_payable",
    });
  });
});

describe("checkout API: events", () => {
  const base = (type: string, data: Record<string, unknown>): IndexedEvent => ({
    id: `ev-${type}-${JSON.stringify(data).length}`,
    type,
    created: 1_762_768_800,
    data: { token_id: "c-101", order_ref: "ORD-1", ...data },
    indexed: true,
  });
  const expand = (h: H, event: IndexedEvent) => expandEvents(event, [h.module], h.context());
  const derived = (h: H, event: IndexedEvent) => expand(h, event).slice(1);
  async function withTwo(h = harness()) {
    await createCheckout(h, { order_ref: "ORD-1" });
    await createCheckout(h, { order_ref: "ORD-2" });
    return h;
  }

  it("checkout_events_are_built_only_from_the_contract_events", async () => {
    const h = await withTwo();
    const table: [string, string][] = [
      ["checkout_created", "checkout.created"],
      ["checkout_paid", "checkout.paid"],
      ["checkout_partial", "checkout.partial"],
      ["checkout_paid_late", "checkout.paid_late"],
      ["checkout_accepted", "checkout.accepted"],
      ["checkout_refund_started", "checkout.refund_started"],
    ];
    for (const [from, to] of table) {
      const out = derived(h, base(from, { booking_seq: 3 }));
      expect(out.map((e) => e.type)).toEqual([to]);
      expect(out[0]?.data).toMatchObject({ token_id: "c-101", order_ref: "ORD-1" });
      expect(out[0]?.indexed).toBe(true);
    }
    // nothing else produces a checkout notice, and the original event stays first
    for (const other of ["booked", "issue", "distributed", "checkout_unheard_of", "invoice.paid"]) {
      const event = base(other, {});
      expect(expand(h, event)).toEqual([event]);
    }
    // creating a checkout through the API raises no event by itself
    await createCheckout(h, { order_ref: "ORD-3" });
    expect(h.issueFor).not.toHaveBeenCalled();
  });

  it("checkout_notification_idempotent", async () => {
    const h = await withTwo();
    const event = base("checkout_paid", { booking_seq: 7 });
    const a = derived(h, event)[0];
    const b = derived(h, { ...event, id: "another-log-line-of-the-same-booking" })[0];
    expect(a?.id).toBe(b?.id);
    expect(a?.id).toBe(createHash("sha256").update("c-101").update("7").digest("hex"));
    const next = derived(h, base("checkout_paid", { booking_seq: 8 }))[0];
    expect(next?.id).not.toBe(a?.id);
    const other = derived(h, { ...event, data: { ...event.data, token_id: "c-102" } })[0];
    expect(other?.id).not.toBe(a?.id);
  });

  it("checkout_notification_ids_differ_between_kinds_of_notice", async () => {
    const h = await withTwo();
    const ids = ["checkout_created", "checkout_accepted", "checkout_refund_started"].map(
      (type) => derived(h, base(type, {}))[0]?.id,
    );
    expect(new Set(ids).size).toBe(3);
    // and a notice without a booking number falls back to the log line, so it still fires once
    const first = derived(h, base("checkout_paid", {}))[0];
    const same = derived(h, base("checkout_paid", {}))[0];
    expect(first?.id).toBe(same?.id);
  });

  it("checkout_partial_notice_never_says_paid", async () => {
    const h = await withTwo();
    const [partial] = derived(
      h,
      base("checkout_partial", {
        booking_seq: 1,
        due: "2000000",
        received: "1000000",
        remaining: "1000000",
      }),
    );
    expect(partial?.type).toBe("checkout.partial");
    expect(partial?.data).toMatchObject({
      due: "2000000",
      received: "1000000",
      remaining: "1000000",
      status: "partial",
    });
    expect(JSON.stringify(partial).toLowerCase()).not.toContain("paid");
  });

  it("checkout_paid_late_notice_says_late_and_not_paid_in_time", async () => {
    const h = await withTwo();
    const [late] = derived(h, base("checkout_paid_late", { booking_seq: 1 }));
    expect(late?.data.status).toBe("late");
  });

  it("checkout_refund_started_carries_the_recorded_refund_to", async () => {
    const h = await withTwo();
    const [refund] = derived(
      h,
      base("checkout_refund_started", { refund_to: PAYER_REFUND_TO, amount_in: "1990000" }),
    );
    expect(refund?.data).toMatchObject({ refund_to: PAYER_REFUND_TO, amount_in: "1990000" });
  });

  it("checkout_events_ignore_malformed_events_without_throwing", async () => {
    const h = await withTwo();
    const events: IndexedEvent[] = [
      { id: "x", type: "checkout_paid", created: 1, data: {}, indexed: true },
      { id: "y", type: "checkout_paid", created: 1, data: { token_id: 5 }, indexed: true },
      { id: "z", type: "checkout_partial", created: 1, data: undefined as never, indexed: true },
    ];
    for (const event of events) expect(derived(h, event)).toEqual([]);
  });

  it("checkout_notification_from_booked_event_only", async () => {
    // A `booked` event of a checkout claim is core's; the module must not turn it into a notice.
    const h = await withTwo();
    expect(derived(h, base("booked", { payment: "2000000" }))).toEqual([]);
  });
});

describe("checkout API: late payments never sign for the merchant", () => {
  let lateSeq = 0;
  async function lateCheckout(h: H, state: Partial<ChainCheckoutState> = {}) {
    lateSeq += 1;
    const id = (await createCheckout(h, { order_ref: `LATE-${lateSeq}` })).body.id as string;
    const expiry = Number(h.chain.claims.get(id)?.due_date);
    h.chain.claims.set(id, {
      ...(h.chain.claims.get(id) ?? {}),
      booked_total: "2000000",
      status: "Paid",
    });
    h.chain.states.set(id, {
      expiry,
      late: true,
      refunded: false,
      order_ref: "ORD-1",
      ...state,
    });
    h.chain.log.set(id, [
      {
        quote_id: "q_payer",
        deposit_address: "0xdeposit",
        deadline_requested: expiry,
        refund_to: PAYER_REFUND_TO,
        route_id: "base-usdc",
      },
    ]);
    h.advance(20 * 60_000);
    return id;
  }
  const post = (h: H, id: string, action: string, body: unknown = {}, secret = h.keys.acme) =>
    call(h, "POST", `/v1/checkouts/${id}/${action}`, body, secret, {
      "idempotency-key": `${action}-${++idem}`,
    });

  it("checkout_accept_late_returns_the_call_for_the_merchant_wallet", async () => {
    const h = harness();
    const id = await lateCheckout(h);
    const response = await post(h, id, "accept_late");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      signer_id: ACME,
      action: {
        receiver_id: "openrail.near",
        method: "accept_late",
        args: { token_id: id },
        deposit: "0",
      },
    });
    expect(h.issueFor).not.toHaveBeenCalled();
  });

  it("checkout_accept_late_refused_unless_late_and_open", async () => {
    const h = harness();
    const notLate = (await createCheckout(h)).body.id as string;
    const refused = await post(h, notLate, "accept_late");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("checkout_not_late");
    const accepted = await lateCheckout(h, { accepted: true });
    expect((await post(h, accepted, "accept_late")).body.error.code).toBe(
      "checkout_already_accepted",
    );
    const refunded = await lateCheckout(h, { refunded: true });
    expect((await post(h, refunded, "accept_late")).body.error.code).toBe(
      "checkout_already_refunded",
    );
  });

  it("checkout_late_actions_are_scoped_and_need_write_scope_and_a_key", async () => {
    const h = harness();
    const id = await lateCheckout(h);
    expect((await post(h, id, "accept_late", {}, h.keys.other)).status).toBe(404);
    expect((await post(h, id, "accept_late", {}, h.keys.acmeRead)).status).toBe(403);
    const noKey = await call(h, "POST", `/v1/checkouts/${id}/accept_late`, {}, h.keys.acme);
    expect(noKey.body.error.code).toBe("idempotency_key_required");
    expect(
      (await call(h, "POST", `/v1/checkouts/${id}/refund_quote`, {}, h.keys.acme)).status,
    ).toBe(400);
  });

  it("late_checkout_refund_only_to_recorded_refund_to", async () => {
    const h = harness();
    const id = await lateCheckout(h);
    const attacker = "0x9999999999999999999999999999999999999999";
    const response = await post(h, id, "refund_quote", {
      refund_to: attacker,
      recipient: attacker,
      destination: attacker,
    });
    expect(response.status).toBe(200);
    expect(h.refundQuote).toHaveBeenCalledTimes(1);
    expect(h.refundQuote.mock.calls[0]?.[0]).toMatchObject({
      tokenId: id,
      refundTo: PAYER_REFUND_TO,
      routeId: "base-usdc",
    });
    expect(JSON.stringify(response.body)).not.toContain(attacker);
    expect(response.body).toMatchObject({
      refund_to: PAYER_REFUND_TO,
      quote: { quote_id: "rq_1", deposit_address: "deposit-near-addr", amount_in: "1990000" },
      action: {
        receiver_id: "openrail.near",
        method: "refund_late",
        args: { token_id: id, deposit_address: "deposit-near-addr", amount_in: "1990000" },
        deposit: "0",
      },
    });
    expect(h.issueFor).not.toHaveBeenCalled();
  });

  it("late_checkout_refund_refuses_a_quote_that_pays_somebody_else", async () => {
    const h = harness();
    const id = await lateCheckout(h);
    h.refundQuote.mockImplementationOnce(async (input) => ({
      quote_id: "rq_bad",
      deposit_address: "d",
      amount_in: "1",
      amount_out: input.amount,
      deadline: new Date().toISOString(),
      recipient: "0x9999999999999999999999999999999999999999",
    }));
    const response = await post(h, id, "refund_quote");
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("refund_quote_recipient_mismatch");
    expect(response.body.action).toBeUndefined();
  });

  it("late_checkout_refund_once", async () => {
    const h = harness();
    const id = await lateCheckout(h, { refunded: true });
    const response = await post(h, id, "refund_quote");
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("checkout_already_refunded");
    expect(h.refundQuote).not.toHaveBeenCalled();
  });

  it("late_checkout_refund_refused_after_accept_or_when_not_late", async () => {
    const h = harness();
    const accepted = await lateCheckout(h, { accepted: true });
    expect((await post(h, accepted, "refund_quote")).body.error.code).toBe(
      "checkout_already_accepted",
    );
    const onTime = (await createCheckout(h, { order_ref: "ON-TIME" })).body.id as string;
    expect((await post(h, onTime, "refund_quote")).body.error.code).toBe("checkout_not_late");
    expect(h.refundQuote).not.toHaveBeenCalled();
  });

  it("late_checkout_refund_needs_a_recorded_refund_to", async () => {
    const h = harness();
    const id = await lateCheckout(h);
    h.chain.log.set(id, []);
    const response = await post(h, id, "refund_quote", { refund_to: PAYER_REFUND_TO });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("no_recorded_refund_to");
    expect(h.refundQuote).not.toHaveBeenCalled();
  });

  it("late_checkout_refund_chooses_among_recorded_quotes_only", async () => {
    const h = harness();
    const id = await lateCheckout(h);
    const other = "0x2222222222222222222222222222222222222222";
    h.chain.log.set(id, [
      ...(h.chain.log.get(id) ?? []),
      {
        quote_id: "q_two",
        deposit_address: "0xd2",
        deadline_requested: 1,
        refund_to: other,
        route_id: "arb-eth",
      },
    ]);
    const ambiguous = await post(h, id, "refund_quote");
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error.code).toBe("ambiguous_refund_to");
    const picked = await post(h, id, "refund_quote", { quote_id: "q_two" });
    expect(picked.status).toBe(200);
    expect(h.refundQuote.mock.calls[0]?.[0]).toMatchObject({ refundTo: other, routeId: "arb-eth" });
    const unknown = await post(h, id, "refund_quote", { quote_id: "q_forged" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("quote_not_found");
  });

  it("checkout_refund_amount_is_the_booked_net_and_never_more", async () => {
    const h = harness();
    // 1. Reads contract `held_amount` serialized as U128 string (e.g. 60% late net in partial split)
    const id = await lateCheckout(h, { held_amount: "1197000" });
    await post(h, id, "refund_quote");
    expect(h.refundQuote.mock.calls[0]?.[0].amount).toBe("1197000");

    // 2. Reads contract `held_amount` serialized as U128 struct `{ "0": "..." }`
    const structId = await lateCheckout(h, { held_amount: { 0: "1990000" } });
    h.refundQuote.mockClear();
    await post(h, structId, "refund_quote");
    expect(h.refundQuote.mock.calls[0]?.[0].amount).toBe("1990000");

    // 3. Refuses if swap quote returns `amount_in` greater than `held_amount`
    h.refundQuote.mockImplementationOnce(async (input) => ({
      quote_id: "rq_over",
      deposit_address: "deposit-near-addr",
      amount_in: "1990001",
      amount_out: input.amount,
      deadline: new Date().toISOString(),
      recipient: input.refundTo,
    }));
    const over = await post(h, structId, "refund_quote");
    expect(over.status).toBe(502);
    expect(over.body.error.code).toBe("refund_quote_exceeds_held_amount");

    // 4. Fallback when mock state omits held_amount
    const second = await lateCheckout(h);
    h.refundQuote.mockClear();
    await post(h, second, "refund_quote");
    expect(h.refundQuote.mock.calls[0]?.[0].amount).toBe("2000000");
  });

  it("checkout_later_late_arrival_after_refund_shows_late_and_can_be_refunded_again", async () => {
    const h = harness();
    const id = await lateCheckout(h, {
      refunded: true,
      accepted: false,
      held_amount: "0",
      flagged: false,
    });
    // Right after first refund (`held_amount: "0"`), status is `refunded` and a second refund is refused
    const afterFirstRefund = await call(h, "GET", `/v1/checkouts/${id}`, undefined, h.keys.acme);
    expect(afterFirstRefund.body.status).toBe("refunded");
    expect((await post(h, id, "refund_quote")).body.error.code).toBe("checkout_already_refunded");

    // A later late arrival lands on chain and is held again (`held_amount: "997500"`)
    const prev = h.chain.states.get(id)!;
    h.chain.states.set(id, {
      ...prev,
      refunded: true,
      held_amount: "997500",
    });
    const afterSecondArrival = await call(h, "GET", `/v1/checkouts/${id}`, undefined, h.keys.acme);
    expect(afterSecondArrival.body.status).toBe("late");
    expect((await call(h, "GET", `/v1/public/checkouts/${id}`)).body.status).toBe("late");

    h.refundQuote.mockClear();
    const secondRefund = await post(h, id, "refund_quote");
    expect(secondRefund.status).toBe(200);
    expect(h.refundQuote.mock.calls[0]?.[0].amount).toBe("997500");
    expect(secondRefund.body.action.args.amount_in).toBe("997500");
  });

  it("checkout_late_actions_refused_when_flagged", async () => {
    const h = harness();
    const id = await lateCheckout(h, {
      held_amount: "1995000",
      flagged: true,
    });
    const acceptRes = await post(h, id, "accept_late");
    expect(acceptRes.status).toBe(409);
    expect(acceptRes.body.error.code).toBe("checkout_flagged");
    const refundRes = await post(h, id, "refund_quote");
    expect(refundRes.status).toBe(409);
    expect(refundRes.body.error.code).toBe("checkout_flagged");
  });

  it("checkout_integration_against_rel2_contract_bundle_snapshots", async () => {
    // Drives the API against exact JSON views (`claim`, `checkout_state`, `payment_log`)
    // and `EVENT_JSON` payloads emitted by `openrail::Contract` (`rel2-checkout.bundle`)
    // for checkouts issued via `issue_for(kind = 1)`.
    const h = harness();
    const c1 = (await createCheckout(h, { order_ref: "ORD-BUNDLE-1" })).body.id as string;
    const expiry = Math.floor(NOW.getTime() / 1000) + 900;

    // 1. Right after `issue_for(kind = 1)`: `checkout_state` is `null` on chain.
    h.chain.claims.set(c1, {
      token_id: c1,
      kind: 1,
      issuer_id: ACME,
      owner_id: ACME,
      claim_account: `${c1}.openrail.near`,
      debtor: null,
      amount_due: "2000000",
      due_date: expiry,
      status: "Issued",
      booked_total: "0",
      distributed_total: "0",
      fee_total: "0",
      surplus: "0",
      credit_total: "0",
    });
    h.chain.states.set(c1, null);
    expect(
      (await call(h, "GET", `/v1/checkouts/${c1}`, undefined, h.keys.acme)).body,
    ).toMatchObject({
      status: "pending",
      claim_account: `${c1}.openrail.near`,
      order_ref: "ORD-BUNDLE-1",
      outstanding: "2000000",
    });

    // 2. Partial booking (`800000`) on `issue_for(kind = 1)`: contract materializes `CheckoutState`
    // with `order_ref = token_id` (`c-101`) and emits `checkout_partial` with `order_ref: c-101`
    // and `total_received: "800000"` (no `booking_seq`).
    h.chain.claims.set(c1, {
      ...(h.chain.claims.get(c1) ?? {}),
      status: "PartiallyPaid",
      booked_total: "800000",
      distributed_total: "798000",
      fee_total: "2000",
    });
    h.chain.states.set(c1, {
      expiry,
      late: false,
      refunded: false,
      accepted: false,
      order_ref: c1,
      notified: [`${c1}:800000`],
      held_amount: "0",
      flagged: false,
    });
    expect(
      (await call(h, "GET", `/v1/checkouts/${c1}`, undefined, h.keys.acme)).body,
    ).toMatchObject({
      status: "partial",
      order_ref: "ORD-BUNDLE-1",
      paid_total: "800000",
      outstanding: "1200000",
    });
    const partialNotice = expandEvents(
      {
        id: "ev-bundle-partial",
        type: "checkout_partial",
        created: 1_762_768_920,
        data: {
          token_id: c1,
          order_ref: c1,
          due: "2000000",
          received: "800000",
          total_received: "800000",
          remaining: "1200000",
          status: "partial",
        },
        indexed: true,
      },
      [h.module],
      h.context(),
    )[1];
    expect(partialNotice).toMatchObject({
      type: "checkout.partial",
      data: {
        token_id: c1,
        order_ref: "ORD-BUNDLE-1",
        due: "2000000",
        received: "800000",
        total_received: "800000",
        remaining: "1200000",
        status: "partial",
      },
    });
    expect(JSON.stringify(partialNotice).toLowerCase()).not.toContain("paid");

    // 3. Late arrival after `expiry + LATE_GRACE_SECONDS`: contract sets `claim.status = "Paid"`,
    // subtracts held net from `distributed_total` (`"0"`), and sets `held_amount: "997500"`.
    const c3 = (await createCheckout(h, { order_ref: "ORD-BUNDLE-3" })).body.id as string;
    h.chain.claims.set(c3, {
      token_id: c3,
      kind: 1,
      issuer_id: ACME,
      owner_id: ACME,
      claim_account: `${c3}.openrail.near`,
      amount_due: "2000000",
      due_date: expiry,
      status: "PartiallyPaid",
      booked_total: "1000000",
      distributed_total: "0",
      fee_total: "2500",
      surplus: "0",
      credit_total: "0",
    });
    h.chain.states.set(c3, {
      expiry,
      late: true,
      refunded: false,
      accepted: false,
      order_ref: c3,
      notified: [`${c3}:1000000`],
      held_amount: "997500",
      flagged: false,
    });
    h.chain.log.set(c3, [
      {
        quote_id: "q-payer-3",
        deposit_address: "0xdep3",
        deadline_requested: expiry,
        refund_to: PAYER_REFUND_TO,
        route_id: "base-usdc",
      },
    ]);
    const refund1 = await post(h, c3, "refund_quote");
    expect(refund1.status).toBe(200);
    expect(refund1.body.action.args).toEqual({
      token_id: c3,
      deposit_address: "deposit-near-addr",
      amount_in: "997500",
    });

    // After first `refund_late`, `refunded: true` and `held_amount: "0"`; then a second late arrival
    // (`1000000`, net `997500`) sets `held_amount: "997500"` while `refunded` stays `true`.
    h.chain.claims.set(c3, {
      ...(h.chain.claims.get(c3) ?? {}),
      status: "Paid",
      booked_total: "2000000",
      distributed_total: "0",
      fee_total: "5000",
    });
    h.chain.states.set(c3, {
      expiry,
      late: true,
      refunded: true,
      accepted: false,
      order_ref: c3,
      notified: [`${c3}:1000000`, `${c3}:2000000`],
      held_amount: "997500",
      flagged: false,
    });
    expect((await call(h, "GET", `/v1/checkouts/${c3}`, undefined, h.keys.acme)).body.status).toBe(
      "late",
    );
    const refund2 = await post(h, c3, "refund_quote");
    expect(refund2.status).toBe(200);
    expect(refund2.body.action.args.amount_in).toBe("997500");
  });

  describe("fee mode", () => {
    it("checkout_fee_mode_table_rounding_up", () => {
      const cases = [
        { subtotal: "12.00", fee: "0.03", total: "12.03" },
        { subtotal: "0.01", fee: "0.01", total: "0.02" },
        { subtotal: "1000.00", fee: "2.50", total: "1002.50" },
        { subtotal: "33.33", fee: "0.09", total: "33.42" },
        { subtotal: "4.00", fee: "0.01", total: "4.01" }, // exact landing on a cent
      ];
      for (const c of cases) {
        const breakdown = computeFeeBreakdown(c.subtotal, "pass_to_customer");
        expect(breakdown.feeUsd).toBe(c.fee);
        expect(breakdown.totalUsd).toBe(c.total);

        // Arithmetic in USDC units: contract takes payment * 25 / 10000 truncated.
        // Merchant net must be within 1 cent (10,000 units of 1e6) of subtotal.
        const paymentUnits = BigInt(Math.round(Number(c.total) * 1_000_000));
        const contractFeeUnits = (paymentUnits * 25n) / 10000n;
        const merchantNetUnits = paymentUnits - contractFeeUnits;
        const subtotalUnits = BigInt(Math.round(Number(c.subtotal) * 1_000_000));
        const diff = Number(merchantNetUnits - subtotalUnits);
        expect(Math.abs(diff)).toBeLessThanOrEqual(10_000); // within 1 cent
      }

      // absorb mode returns 0.00 fee and unchanged total
      const absorb = computeFeeBreakdown("12.00", "absorb");
      expect(absorb.feeUsd).toBe("0.00");
      expect(absorb.totalUsd).toBe("12.00");
    });

    it("checkout_creates_with_fee_mode_pass_to_customer", async () => {
      const h = harness();
      const res = await call(
        h,
        "POST",
        "/v1/checkouts",
        {
          order_ref: "ORD-FEE-PASS",
          amount_usd: "12.00",
          fee_mode: "pass_to_customer",
        },
        h.keys.acme,
        { "idempotency-key": "idem-fee-pass" },
      );

      expect(res.status).toBe(201);
      expect(res.body.subtotal_usd).toBe("12.00");
      expect(res.body.fee_usd).toBe("0.03");
      expect(res.body.total_usd).toBe("12.03");
      expect(res.body.amount_usd).toBe("12.03");
      expect(res.body.fee_mode).toBe("pass_to_customer");
      // On-chain claim amount is total_usd ($12.03)
      expect(res.body.amount_due).toBe("12030000");

      // GET /v1/checkouts/:id returns the breakdown
      const get = await call(h, "GET", `/v1/checkouts/${res.body.id}`, undefined, h.keys.acme);
      expect(get.status).toBe(200);
      expect(get.body.subtotal_usd).toBe("12.00");
      expect(get.body.fee_usd).toBe("0.03");
      expect(get.body.total_usd).toBe("12.03");
      expect(get.body.fee_mode).toBe("pass_to_customer");

      // GET /v1/public/checkouts/:id returns the breakdown
      const pub = await call(h, "GET", `/v1/public/checkouts/${res.body.id}`);
      expect(pub.status).toBe(200);
      expect(pub.body.subtotal_usd).toBe("12.00");
      expect(pub.body.fee_usd).toBe("0.03");
      expect(pub.body.total_usd).toBe("12.03");
      expect(pub.body.fee_mode).toBe("pass_to_customer");
    });

    it("checkout_creates_with_fee_mode_absorb", async () => {
      const h = harness();
      const res = await call(
        h,
        "POST",
        "/v1/checkouts",
        {
          order_ref: "ORD-FEE-ABSORB",
          amount_usd: "12.00",
          fee_mode: "absorb",
        },
        h.keys.acme,
        { "idempotency-key": "idem-fee-absorb" },
      );

      expect(res.status).toBe(201);
      expect(res.body.subtotal_usd).toBe("12.00");
      expect(res.body.fee_usd).toBe("0.00");
      expect(res.body.total_usd).toBe("12.00");
      expect(res.body.amount_usd).toBe("12.00");
      expect(res.body.fee_mode).toBe("absorb");
      expect(res.body.amount_due).toBe("12000000");
    });

    it("checkout_fee_mode_defaults_to_business_setting", async () => {
      const h = harness();
      // Set business setting to pass_to_customer
      h.context().store.saveBusiness({
        account_id: ACME,
        legal_name: "Acme",
        payout_account: ACME,
        contact_email: "a@example.com",
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
        fee_mode: "pass_to_customer",
      } as unknown as BusinessRecord);

      const res = await call(
        h,
        "POST",
        "/v1/checkouts",
        {
          order_ref: "ORD-FEE-BIZ",
          amount_usd: "12.00",
        },
        h.keys.acme,
        { "idempotency-key": "idem-fee-biz" },
      );

      expect(res.status).toBe(201);
      expect(res.body.fee_mode).toBe("pass_to_customer");
      expect(res.body.total_usd).toBe("12.03");
    });

    it("checkout_invalid_fee_mode_rejected", async () => {
      const h = harness();
      const res = await call(
        h,
        "POST",
        "/v1/checkouts",
        {
          order_ref: "ORD-FEE-ERR",
          amount_usd: "12.00",
          fee_mode: "invalid_mode",
        },
        h.keys.acme,
        { "idempotency-key": "idem-fee-err" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_fee_mode");
    });

    it("checkout_idempotency_different_fee_mode_conflicts", async () => {
      const h = harness();
      const key = "idem-fee-conflict-1";
      const res1 = await call(
        h,
        "POST",
        "/v1/checkouts",
        { order_ref: "ORD-IDEM-FEE", amount_usd: "12.00", fee_mode: "absorb" },
        h.keys.acme,
        { "idempotency-key": key },
      );
      expect(res1.status).toBe(201);

      // Reusing key with different fee_mode produces 409 idempotency conflict
      const res2 = await call(
        h,
        "POST",
        "/v1/checkouts",
        { order_ref: "ORD-IDEM-FEE", amount_usd: "12.00", fee_mode: "pass_to_customer" },
        h.keys.acme,
        { "idempotency-key": key },
      );
      expect(res2.status).toBe(409);
    });

    it("checkout_events_carry_fee_breakdown", async () => {
      const h = harness();
      const res = await call(
        h,
        "POST",
        "/v1/checkouts",
        {
          order_ref: "ORD-FEE-EVT",
          amount_usd: "12.00",
          fee_mode: "pass_to_customer",
        },
        h.keys.acme,
        { "idempotency-key": "idem-fee-evt" },
      );

      const tokenId = res.body.id;
      const rawEvent: IndexedEvent = {
        id: "evt-fee-1",
        type: "checkout_paid",
        created: Math.floor(NOW.getTime() / 1000),
        indexed: true,
        data: {
          token_id: tokenId,
          order_ref: "ORD-FEE-EVT",
          booking_seq: 1,
        },
      };
      const notices = h.module.events!(rawEvent, h.context());
      expect(notices).toHaveLength(1);
      const data = notices[0]!.data as Record<string, unknown>;
      expect(data.subtotal_usd).toBe("12.00");
      expect(data.fee_usd).toBe("0.03");
      expect(data.total_usd).toBe("12.03");
      expect(data.fee_mode).toBe("pass_to_customer");
    });
  });
});
