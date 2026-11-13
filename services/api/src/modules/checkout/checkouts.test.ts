import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApiApp, ApiError, type ApiDeps, type BusinessRecord } from "../../app.js";
import { AuthStore } from "../../auth.js";
import { sha256Hex0x } from "../../crypto.js";
import { expandEvents } from "../../modules.js";
import { createMemoryStores } from "../../stores.js";
import { WebhookWorker } from "../../webhook-worker.js";
import { signWebhook } from "../../webhooks.js";
import type { IndexedEvent } from "../../webhooks.js";
import type {
  CheckoutChain,
  ChainCheckoutState,
  LoggedQuote,
  RefundQuotePort,
} from "./checkouts.js";
import { computeFeeBreakdown } from "./checkouts.js";
import type { CheckoutPort } from "./checkout-port.js";
import { checkoutTermsHash, EMPTY_ITEMS_SHA256 } from "./checkout-port.js";
import { createCheckoutApiModule, CHECKOUT_EVENT_TYPES } from "./index.js";
import { createIssuerApp } from "../../../../issuer/src/http.js";
import type { IssuerService } from "../../../../issuer/src/service.js";

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

function harness(
  options: {
    config?: Partial<ApiDeps["config"]>;
    useRealPort?: boolean;
    issuer?: ApiDeps["issuer"];
    modules?: ApiDeps["modules"];
    indexer?: ApiDeps["indexer"];
    chain?: CheckoutChain;
  } = {},
) {
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
  const claimSpy = vi.fn(async (token: string) => {
    const found = chain.claims.get(token);
    if (found === undefined) throw new Error("claim not found");
    return found;
  });
  const checkoutStateSpy = vi.fn(async (token: string) => chain.states.get(token) ?? null);
  const paymentLogSpy = vi.fn(async (token: string) => chain.log.get(token) ?? []);
  const fakeChain: CheckoutChain = {
    claim: claimSpy,
    checkoutState: checkoutStateSpy,
    paymentLog: paymentLogSpy,
  };
  const poke = vi.fn(async () => undefined);
  const refundQuote = vi.fn<RefundQuotePort["quote"]>(async (input) => ({
    quote_id: "rq_1",
    deposit_address: "deposit-near-addr",
    amount_in: input.amount === "2000000" ? "1990000" : input.amount,
    amount_out: input.amount,
    deadline: new Date(clock().getTime() + 600_000).toISOString(),
    recipient: input.refundTo,
  }));
  const module = createCheckoutApiModule({
    ...(options.useRealPort ? {} : { checkouts: () => ({ create }) }),
    chain: () => options.chain ?? fakeChain,
    refunds: () => ({ quote: refundQuote }),
  });
  const issueFor = vi.fn(async () => ({
    txHash: "0xissue",
    tokenId: "c-1",
    claimAccount: "c-1.openrail.near",
  }));
  const deps: ApiDeps = {
    config: {
      rootAccount: "openrail.near",
      recipient: "api.openrail.near",
      payBaseUrl: "https://pay.example",
      ...options.config,
    },
    auth,
    issuer: options.issuer ?? {
      prepareIssue: vi.fn(async () => ({
        account: "openrail.near",
        amount: "1",
        storageCredit: "1000",
        tokenId: "c-1",
        claimAccount: "c-1.openrail.near",
      })),
      issueFor,
      logQuote: vi.fn(),
      acknowledgeEvm: vi.fn(),
    },
    contract: { claim: vi.fn(), storageCredit: vi.fn() },
    accessKey: { has: async () => true },
    verifier: () => true,
    cashout: { quote: async () => ({}) },
    pokeIndexer: poke,
    clock,
    modules: options.modules ?? [module],
    ...(options.indexer === undefined ? {} : { indexer: options.indexer }),
  };
  const app = new ApiApp(deps);
  return {
    app,
    module,
    create,
    refundQuote,
    poke,
    issueFor,
    keys,
    chain,
    fakeChain,
    claimSpy,
    checkoutStateSpy,
    paymentLogSpy,
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

describe("checkout history on the public page (11 Nov: the paid page showed no history, an invoice does)", () => {
  it("a paid checkout's public view lists the dates and the transactions that prove the payment", async () => {
    const receipts = [
      {
        time: "2026-11-11T05:23:10.000Z",
        origin_tx: { hash: "0xe1b5764529654a62b8604ff286dfe8dea87778e94aebc31b6be4efb979f2a5a9" },
        near_tx_hashes: ["DJyPo1C5NXEg7TReunqxJB2gscLpeeQdPfNg1qsj4EM5"],
        booking_tx: "CVRtjVbZoLmqj82YCrvTBdd7K5DRhdLq9N3hJc39AAKb",
      },
    ];
    const indexer = {
      listReceipts: vi.fn(async () => receipts),
      issueTx: vi.fn(async () => "IssueTxHash111111111111111111111111111111111"),
    } as unknown as ApiDeps["indexer"];
    const h = harness({ indexer });
    const created = await createCheckout(h);
    const id = created.body.id as string;
    const claim = h.chain.claims.get(id);
    if (claim !== undefined) {
      claim.booked_total = claim.amount_due;
      claim.distributed_total = claim.amount_due;
    }
    const view = (await call(h, "GET", `/v1/public/checkouts/${id}`)).body;
    expect(view.status).toBe("paid");
    const history = view.history as {
      issued_at: string;
      paid_at: string | null;
      issue_tx: string | null;
      payments: { tx_hash: string; near: boolean }[];
    };
    expect(history.paid_at).toBe("2026-11-11T05:23:10.000Z");
    expect(history.issue_tx).toBe("IssueTxHash111111111111111111111111111111111");
    expect(history.payments).toEqual([
      { tx_hash: receipts[0]!.origin_tx.hash, near: false },
      { tx_hash: "DJyPo1C5NXEg7TReunqxJB2gscLpeeQdPfNg1qsj4EM5", near: true },
      { tx_hash: "CVRtjVbZoLmqj82YCrvTBdd7K5DRhdLq9N3hJc39AAKb", near: true },
    ]);
    expect(typeof history.issued_at).toBe("string");
  });

  it("an open checkout has no history to show, and a failing indexer never takes the page down", async () => {
    const indexer = {
      listReceipts: vi.fn(async () => {
        throw new Error("indexer down");
      }),
    } as unknown as ApiDeps["indexer"];
    const h = harness({ indexer });
    const id = (await createCheckout(h)).body.id as string;
    const open = await call(h, "GET", `/v1/public/checkouts/${id}`);
    expect(open.status).toBe(200);
    expect(open.body.history).toBeUndefined();
    const claim = h.chain.claims.get(id);
    if (claim !== undefined) {
      claim.booked_total = claim.amount_due;
      claim.distributed_total = claim.amount_due;
    }
    const paid = await call(h, "GET", `/v1/public/checkouts/${id}`);
    expect(paid.status).toBe(200);
    expect((paid.body.history as { payments: unknown[] }).payments).toEqual([]);
  });
});

describe("checkout freshness", () => {
  it("pokes once when a public checkout is first seen paid", async () => {
    const h = harness();
    const created = await createCheckout(h);
    const id = created.body.id as string;
    const claim = h.chain.claims.get(id);
    if (claim !== undefined) {
      claim.booked_total = claim.amount_due;
      claim.distributed_total = claim.amount_due;
    }
    expect((await call(h, "GET", `/v1/public/checkouts/${id}`)).body.status).toBe("paid");
    expect((await call(h, "GET", `/v1/public/checkouts/${id}`)).body.status).toBe("paid");
    expect(h.poke).toHaveBeenCalledTimes(1);
  });

  it("pokes once when the same checkout event is delivered again", async () => {
    const h = harness();
    const created = await createCheckout(h);
    const tokenId = created.body.token_id as string;
    const event = {
      id: "evt-1",
      type: "checkout_partial",
      created: Math.floor(NOW.getTime() / 1000),
      data: { token_id: tokenId },
      indexed: true,
    } as IndexedEvent;
    h.module.events?.(event, h.context());
    h.module.events?.(event, h.context());
    expect(h.poke).toHaveBeenCalledTimes(1);
  });
});

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
    // Same merchant, same order_ref, same amount returns 200 with the existing checkout
    const again = await createCheckout(h);
    expect(again.status).toBe(200);
    expect(h.create).toHaveBeenCalledTimes(1);
    // Different amount for same order_ref is 409 order_ref_amount_mismatch
    const mismatch = await createCheckout(h, { amount_usd: "5.00" });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe("order_ref_amount_mismatch");
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
      sha256Hex0x(JSON.stringify([{ name: "Coffee", quantity: 2, unit_price_usd: "1.00" }])),
    );
    await createCheckout(h, { order_ref: "ORD-2" });
    expect(h.create.mock.calls[1]?.[0].itemsSha256).toBe(EMPTY_ITEMS_SHA256);
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
    const expId = await made(h, { order_ref: "ORD-EXP" });
    h.chain.states.set(expId, null);
    h.advance(20 * 60_000);
    const expired = await get(h, expId);
    expect(expired.body).toMatchObject({
      status: "expired",
      outstanding: "2000000",
      paid_total: "0",
    });
    expect((await call(h, "GET", `/v1/public/checkouts/${expId}`)).body.status).toBe("expired");
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

    const theirs = await call(h, "GET", "/v1/checkouts", undefined, h.keys.other);
    expect(theirs.status).toBe(200);
    expect(theirs.body.data).toHaveLength(1);
    expect(theirs.body.data[0].order_ref).toBe("theirs");
  });

  it("checkout_routes_filter_by_merchant", async () => {
    const h = harness();
    const acmeId = await made(h, { order_ref: "ORD-ACME" });
    const otherRes = await createCheckout(h, { order_ref: "ORD-OTHER" }, h.keys.other);
    expect(otherRes.status).toBe(201);
    const otherId = (otherRes.body as { id: string }).id;

    // Listing is strictly filtered by merchant:
    const acmeList = await call(h, "GET", "/v1/checkouts", undefined, h.keys.acme);
    expect(acmeList.status).toBe(200);
    expect(acmeList.body.data.map((c: { id: string }) => c.id)).toEqual([acmeId]);

    const otherList = await call(h, "GET", "/v1/checkouts", undefined, h.keys.other);
    expect(otherList.status).toBe(200);
    expect(otherList.body.data.map((c: { id: string }) => c.id)).toEqual([otherId]);

    // Single checkout view answers 404 for another merchant's checkout:
    expect((await get(h, acmeId, h.keys.other)).status).toBe(404);
    expect((await get(h, otherId, h.keys.acme)).status).toBe(404);

    // Public view is accessible without auth and reports the correct merchant:
    const pubAcme = await call(h, "GET", `/v1/public/checkouts/${acmeId}`);
    expect(pubAcme.status).toBe(200);
    expect(pubAcme.body.merchant).toBe(ACME);

    const pubOther = await call(h, "GET", `/v1/public/checkouts/${otherId}`);
    expect(pubOther.status).toBe(200);
    expect(pubOther.body.merchant).toBe(OTHER);
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

    // When business profile has legal_name, public view includes merchant_name display name:
    h.context().store.saveBusiness({
      account_id: ACME,
      username: "acme",
      legal_name: "Acme Ltd",
      payout_account: ACME,
      contact_email: "billing@acme.test",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const withBiz = await call(h, "GET", `/v1/public/checkouts/${id}`);
    expect(withBiz.status).toBe(200);
    expect(withBiz.body.merchant).toBe(ACME);
    expect(withBiz.body.merchant_name).toBe("Acme Ltd");
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
    expect((await post(h, id, "refund_quote", {}, h.keys.other)).status).toBe(404);
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

    it("checkout_creates_through_real_issuer_http_handler", async () => {
      let issuedPayload: Record<string, unknown> | undefined;
      const fakeChainService = {
        prepareIssue: vi.fn(async () => ({
          account: "openrail.near",
          amount: "1",
          storageCredit: "1000",
          tokenId: "c-42",
          claimAccount: "c-42.openrail.near",
        })),
        issueFor: vi.fn(async (request) => {
          issuedPayload = request as Record<string, unknown>;
          return {
            txHash: "0xissue42",
            tokenId: "c-42",
            claimAccount: "c-42.openrail.near",
          };
        }),
        logQuote: vi.fn(async () => ({ txHash: "0xquote" })),
        acknowledgeEvm: vi.fn(async () => ({ txHash: "0xack", ack: null })),
      } as unknown as IssuerService;

      const issuerApp = createIssuerApp({
        service: fakeChainService,
        serviceKey: "test-secret-key",
        logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never,
      });

      const realIssuerClient: ApiDeps["issuer"] = {
        async prepareIssue(accountId: string) {
          const res = await issuerApp.handle(
            "POST",
            "/issue/prepare",
            { authorization: "Bearer test-secret-key" },
            JSON.stringify({ account_id: accountId }),
          );
          if (res.status !== 200)
            throw new ApiError(res.status, "prepare_failed", "prepare failed");
          return res.body as never;
        },
        async issueFor(request) {
          const res = await issuerApp.handle(
            "POST",
            "/issue",
            { authorization: "Bearer test-secret-key" },
            JSON.stringify(request),
          );
          if (res.status !== 200) {
            const err = res.body as { error?: { message?: string; code?: string } };
            throw new ApiError(
              res.status,
              err?.error?.code ?? "issuer_rejected",
              err?.error?.message ?? "issue failed",
            );
          }
          return res.body as never;
        },
        logQuote: vi.fn(),
        acknowledgeEvm: vi.fn(),
      };

      const h = harness({ useRealPort: true, issuer: realIssuerClient });

      const res = await call(
        h,
        "POST",
        "/v1/checkouts",
        {
          order_ref: "ORD-REAL-ISSUER-1",
          amount_usd: "12.00",
          expires_in_minutes: 15,
        },
        h.keys.acme,
        { "idempotency-key": "idem-real-issuer-1" },
      );

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("c-42");
      expect(issuedPayload).toBeDefined();
      // Verify termsHash begins with 0x and is 66 chars (0x + 64 hex)
      expect(issuedPayload!.termsHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(issuedPayload!.kind).toBe(1);
      expect(issuedPayload!.debtor).toBeNull();
      expect(issuedPayload!.amountDue).toBe("12000000");

      // Verify canonical checkout terms schema has exactly the 5 fields
      const termsObj = {
        amount_usd: "12.00",
        expiry: Math.floor(NOW.getTime() / 1000) + 15 * 60,
        items_sha256: EMPTY_ITEMS_SHA256,
        merchant: ACME,
        order_ref: "ORD-REAL-ISSUER-1",
      };
      expect(issuedPayload!.termsHash).toBe(checkoutTermsHash(termsObj));

      // Negative check: verify that the real issuer HTTP handler refuses a termsHash without 0x
      const badHashRes = await issuerApp.handle(
        "POST",
        "/issue",
        { authorization: "Bearer test-secret-key" },
        JSON.stringify({
          business: ACME,
          kind: 1,
          debtor: null,
          termsHash: (issuedPayload!.termsHash as string).replace(/^0x/, ""),
          amountDue: "12000000",
          dueDate: Math.floor(NOW.getTime() / 1000) + 15 * 60,
          expectedTokenId: "c-42",
        }),
      );
      expect(badHashRes.status).toBe(400);
      expect((badHashRes.body as { error: { message: string } }).error.message).toContain(
        "termsHash must be 0x + 64 hex",
      );
    });

    it("checkout_claim_labels_flag_on_and_off", async () => {
      // 1. When claimLabels is ON
      let issueRequestLabels: Record<string, unknown> | undefined;
      const issuerLabels: ApiDeps["issuer"] = {
        prepareIssue: vi.fn(async () => ({
          account: "openrail.near",
          amount: "1",
          storageCredit: "1000",
          tokenId: "c-1",
          claimAccount: "c-1.openrail.near",
        })),
        issueFor: vi.fn(async (req) => {
          issueRequestLabels = req as Record<string, unknown>;
          return {
            txHash: "0xlabels",
            tokenId: req.claimLabel,
            claimAccount: `${req.claimLabel}.openrail.near`,
          };
        }),
        logQuote: vi.fn(),
        acknowledgeEvm: vi.fn(),
      };
      const hLabels = harness({
        useRealPort: true,
        config: { claimLabels: true },
        issuer: issuerLabels,
      });
      hLabels.context().store.saveBusiness({
        account_id: ACME,
        username: "acmestore",
        legal_name: "Acme Store",
        payout_account: ACME,
        contact_email: "acme@example.com",
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      });

      const resLabels = await call(
        hLabels,
        "POST",
        "/v1/checkouts",
        {
          order_ref: "ORD-LABELS-1",
          amount_usd: "25.00",
        },
        hLabels.keys.acme,
        { "idempotency-key": "idem-labels-1" },
      );

      expect(resLabels.status).toBe(201);
      expect(issueRequestLabels).toBeDefined();
      expect(issueRequestLabels!.claimLabel).toMatch(/^acmestore-[0-9a-f]{12}$/);
      expect(issueRequestLabels).not.toHaveProperty("expectedTokenId");
      expect(resLabels.body.id).toBe(issueRequestLabels!.claimLabel);
      expect(resLabels.body.claim_account).toBe(`${issueRequestLabels!.claimLabel}.openrail.near`);

      // 2. When claimLabels is OFF
      let issueRequestNoLabels: Record<string, unknown> | undefined;
      const issuerNoLabels: ApiDeps["issuer"] = {
        prepareIssue: vi.fn(async () => ({
          account: "openrail.near",
          amount: "1",
          storageCredit: "1000",
          tokenId: "c-1",
          claimAccount: "c-1.openrail.near",
        })),
        issueFor: vi.fn(async (req) => {
          issueRequestNoLabels = req as Record<string, unknown>;
          return {
            txHash: "0xnolabels",
            tokenId: "c-99",
            claimAccount: "c-99.openrail.near",
          };
        }),
        logQuote: vi.fn(),
        acknowledgeEvm: vi.fn(),
      };
      const hNoLabels = harness({
        useRealPort: true,
        config: { claimLabels: false },
        issuer: issuerNoLabels,
      });

      const resNoLabels = await call(
        hNoLabels,
        "POST",
        "/v1/checkouts",
        {
          order_ref: "ORD-NOLABELS-1",
          amount_usd: "25.00",
        },
        hNoLabels.keys.acme,
        { "idempotency-key": "idem-nolabels-1" },
      );

      expect(resNoLabels.status).toBe(201);
      expect(issueRequestNoLabels).toBeDefined();
      expect(issueRequestNoLabels!.expectedTokenId).toBe("c-1");
      expect(issueRequestNoLabels).not.toHaveProperty("claimLabel");
      expect(resNoLabels.body.id).toBe("c-99");
    });

    it("declares checkout webhook event types through ApiModule.eventTypes hook when enabled", async () => {
      const module = createCheckoutApiModule();
      expect(module.eventTypes).toEqual([...CHECKOUT_EVENT_TYPES]);

      // When module is enabled:
      const hWith = harness({ modules: [module] });
      const resWith = await call(
        hWith,
        "GET",
        "/v1/webhook_event_types",
        undefined,
        hWith.keys.acme,
      );
      expect(resWith.status).toBe(200);
      const bodyWith = resWith.body as { types: string[] };
      for (const t of CHECKOUT_EVENT_TYPES) {
        expect(bodyWith.types).toContain(t);
      }

      // When module is disabled (core only):
      const hWithout = harness({ modules: [] });
      const resWithout = await call(
        hWithout,
        "GET",
        "/v1/webhook_event_types",
        undefined,
        hWithout.keys.acme,
      );
      expect(resWithout.status).toBe(200);
      const bodyWithout = resWithout.body as { types: string[] };
      for (const t of CHECKOUT_EVENT_TYPES) {
        expect(bodyWithout.types).not.toContain(t);
      }
    });
  });
});

describe("checkout events reach the merchant: GET /v1/events and a signed webhook", () => {
  /** An indexer that serves one shared, oldest-first stream, as the real one does. */
  function stream(rows: IndexedEvent[]): NonNullable<ApiDeps["indexer"]> {
    return {
      listEvents: async (query: { after?: string; limit?: number; type?: string }) => {
        const after = Number(query.after ?? "0");
        const page = rows
          .filter(
            (e) => Number(e.id) > after && (query.type === undefined || e.type === query.type),
          )
          .slice(0, query.limit ?? 50);
        return { data: page, next_cursor: page.length > 0 ? (page.at(-1)?.id ?? null) : null };
      },
    } as unknown as NonNullable<ApiDeps["indexer"]>;
  }
  const event = (id: number, type: string, token: string, data = {}): IndexedEvent => ({
    id: String(id),
    type,
    created: 1_762_768_800,
    data: { token_id: token, ...data },
    indexed: true,
  });

  it("checkout_events_visible_to_the_owner_and_not_to_another_merchant", async () => {
    // 250 events of other tokens come first: the checkout's event is past the first page
    const rows: IndexedEvent[] = Array.from({ length: 250 }, (_, i) =>
      event(i + 1, "booked", "someone-else"),
    );
    rows.push(event(251, "checkout_paid", "c-101", { booking_seq: 1 }));
    rows.push(event(252, "checkout_paid_late", "c-101", { booking_seq: 2 }));
    const h = harness({ indexer: stream(rows) });
    const made = await createCheckout(h);
    expect(made.body.id).toBe("c-101");
    const mine = await call(h, "GET", "/v1/events", undefined, h.keys.acme);
    expect(mine.status).toBe(200);
    expect((mine.body.data as IndexedEvent[]).map((e) => e.type)).toEqual([
      "checkout_paid",
      "checkout_paid_late",
    ]);
    const theirs = await call(h, "GET", "/v1/events", undefined, h.keys.other);
    expect(theirs.body.data).toEqual([]);
  });

  it("dashboard_reads_checkout_paid_by_its_module_name", async () => {
    // The dashboard asks for `checkout.paid`; the indexer only has `checkout_paid`. Filtering the raw stream by the
    // module name found nothing, and no checkout payment ever reached the dashboard (13 Nov).
    const rows: IndexedEvent[] = [
      event(1, "booked", "someone-else"),
      event(2, "checkout_paid", "c-101", { booking_seq: 1, booking_tx: "BookTx1" }),
    ];
    const h = harness({ indexer: stream(rows) });
    expect((await createCheckout(h, { customer_name: "Ada <b>Lovelace</b>" })).body.id).toBe(
      "c-101",
    );
    const paid = await call(
      h,
      "GET",
      "/v1/events",
      undefined,
      h.keys.acme,
      {},
      new URLSearchParams({ type: "checkout.paid" }),
    );
    expect(paid.status).toBe(200);
    const data = paid.body.data as IndexedEvent[];
    expect(data.map((e) => e.type)).toEqual(["checkout.paid"]);
    expect(data[0]?.data.token_id).toBe("c-101");
    expect(data[0]?.data.booking_tx).toBe("BookTx1");
    // The store's billing name is the payer in the dashboard (angle brackets dropped).
    expect(data[0]?.data.customer_name).toBe("Ada bLovelace/b");
    const theirs = await call(
      h,
      "GET",
      "/v1/events",
      undefined,
      h.keys.other,
      {},
      new URLSearchParams({ type: "checkout.paid" }),
    );
    expect(theirs.body.data).toEqual([]);
  });

  it("checkout_events_visible_without_the_module_only_as_core_events", async () => {
    const h = harness({
      modules: [],
      indexer: stream([event(1, "checkout_paid", "c-101")]),
    });
    const mine = await call(h, "GET", "/v1/events", undefined, h.keys.acme);
    expect(mine.body.data).toEqual([]);
  });

  it("checkout_paid_creates_one_signed_webhook_delivery_with_the_order_reference", async () => {
    const h = await withTwoForWebhook();
    const store = createMemoryStores().api;
    const endpoint = {
      id: "whe_1",
      url: "https://shop.example/hook",
      secret: "whsec_shop",
      events: ["checkout.paid"],
    };
    store.saveWebhookEndpoint(ACME, endpoint);
    const rows = [event(1, "checkout_paid", "c-101", { booking_seq: 4, order_ref: "ORD-1" })];
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const worker = new WebhookWorker({
      events: stream(rows),
      store,
      fetchImpl,
      validateUrl: async () => undefined,
      clock: () => NOW,
      expand: (e) => expandEvents(e, [h.module], h.context()),
    });
    await worker.runOnce();
    await worker.runOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = String(init.body);
    const headers = init.headers as Record<string, string>;
    const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(headers["Openrail-Signature"] ?? "");
    expect(sig).not.toBeNull();
    expect(headers["Openrail-Signature"]).toBe(signWebhook("whsec_shop", Number(sig?.[1]), body));
    const sent = JSON.parse(body) as { type: string; data: Record<string, unknown> };
    expect(sent.type).toBe("checkout.paid");
    expect(sent.data).toMatchObject({ token_id: "c-101", order_ref: "ORD-1", status: "paid" });
  });

  it("order_ref_unique_returns_same_checkout_on_same_amount_and_conflicts_on_different_amount", async () => {
    const h = harness();
    const first = await createCheckout(h, { order_ref: "ORD-SH-100", amount_usd: "25.00" });
    expect(first.status).toBe(201);
    expect(first.body.order_ref).toBe("ORD-SH-100");
    expect(first.body.amount_usd).toBe("25.00");
    const checkoutId = first.body.id;

    // Retry with same order_ref and same amount -> 200 with same checkout
    const retry = await createCheckout(h, { order_ref: "ORD-SH-100", amount_usd: "25.00" });
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(checkoutId);
    expect(retry.body.order_ref).toBe("ORD-SH-100");
    expect(h.create).toHaveBeenCalledTimes(1);

    // Call with same order_ref and different amount -> 409 order_ref_amount_mismatch
    const mismatch = await createCheckout(h, { order_ref: "ORD-SH-100", amount_usd: "35.00" });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe("order_ref_amount_mismatch");

    // Another merchant can use the same order_ref without collision
    const otherMerchant = await createCheckout(
      h,
      { order_ref: "ORD-SH-100", amount_usd: "35.00" },
      h.keys.other,
    );
    expect(otherMerchant.status).toBe(201);
    expect(otherMerchant.body.id).not.toBe(checkoutId);
  });

  it("return_and_cancel_urls_validated_and_returned_in_api_and_public_view", async () => {
    const h = harness();
    // Non-https return_url fails 400
    const badReturn = await createCheckout(h, {
      order_ref: "ORD-URL-1",
      return_url: "http://insecure.example/return",
    });
    expect(badReturn.status).toBe(400);
    expect(badReturn.body.error.code).toBe("invalid_request");

    // Non-https cancel_url fails 400
    const badCancel = await createCheckout(h, {
      order_ref: "ORD-URL-2",
      cancel_url: "javascript:alert(1)",
    });
    expect(badCancel.status).toBe(400);
    expect(badCancel.body.error.code).toBe("invalid_request");

    // Valid URLs accepted, returned in API view and public view
    const ok = await createCheckout(h, {
      order_ref: "ORD-URL-3",
      return_url: "https://shop.example/return",
      cancel_url: "https://shop.example/cancel",
    });
    expect(ok.status).toBe(201);
    expect(ok.body.return_url).toBe("https://shop.example/return");
    expect(ok.body.cancel_url).toBe("https://shop.example/cancel");

    const getRes = await call(h, "GET", `/v1/checkouts/${ok.body.id}`, undefined, h.keys.acme);
    expect(getRes.status).toBe(200);
    expect(getRes.body.return_url).toBe("https://shop.example/return");
    expect(getRes.body.cancel_url).toBe("https://shop.example/cancel");

    const pubRes = await call(h, "GET", `/v1/public/checkouts/${ok.body.id}`);
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.return_url).toBe("https://shop.example/return");
    expect(pubRes.body.cancel_url).toBe("https://shop.example/cancel");
  });

  it("currency_rule_refuses_non_usd_with_named_code_and_accepts_usd_cents", async () => {
    const h = harness();
    // Unsupported currency fails with named code unsupported_currency
    const eur = await call(
      h,
      "POST",
      "/v1/checkouts",
      { order_ref: "ORD-CURR-1", currency: "EUR", amount_usd: "10.00" },
      h.keys.acme,
      { "idempotency-key": "k-curr-1" },
    );
    expect(eur.status).toBe(400);
    expect(eur.body.error.code).toBe("unsupported_currency");

    const gbp = await call(
      h,
      "POST",
      "/v1/checkouts",
      { order_ref: "ORD-CURR-2", currency: "GBP", amount_usd: "10.00" },
      h.keys.acme,
      { "idempotency-key": "k-curr-2" },
    );
    expect(gbp.status).toBe(400);
    expect(gbp.body.error.code).toBe("unsupported_currency");

    // USD is accepted with amount_cents
    const usd = await call(
      h,
      "POST",
      "/v1/checkouts",
      { order_ref: "ORD-CURR-3", currency: "USD", amount_cents: 2999 },
      h.keys.acme,
      { "idempotency-key": "k-curr-3" },
    );
    expect(usd.status).toBe(201);
    expect(usd.body.amount_usd).toBe("29.99");
    expect(usd.body.amount_cents).toBe(2999);
    expect(usd.body.currency).toBe("USD");

    // amount_usd_cents is also accepted
    const usdCents = await call(
      h,
      "POST",
      "/v1/checkouts",
      { order_ref: "ORD-CURR-4", amount_usd_cents: 1550 },
      h.keys.acme,
      { "idempotency-key": "k-curr-4" },
    );
    expect(usdCents.status).toBe(201);
    expect(usdCents.body.amount_usd).toBe("15.50");
    expect(usdCents.body.amount_cents).toBe(1550);
  });

  it("webhook_payloads_carry_order_ref_checkout_id_amount_cents_transactions_and_timestamp", async () => {
    const h = harness();
    await createCheckout(h, { order_ref: "ORD-WH-1", amount_usd: "12.34" });

    const rawEvent: IndexedEvent = {
      id: "ev_1",
      type: "checkout_paid",
      created: 1_762_768_800,
      data: {
        token_id: "c-101",
        tx_hash: "0xbookingtx123",
        origin_tx: "0xorigintx456",
      },
      indexed: true,
    };

    const expanded = expandEvents(rawEvent, [h.module], h.context());
    expect(expanded).toHaveLength(2);
    const ev = expanded[1]!;
    expect(ev.type).toBe("checkout.paid");
    expect(ev.data).toMatchObject({
      checkout_id: "c-101",
      token_id: "c-101",
      order_ref: "ORD-WH-1",
      amount_usd: "12.34",
      amount_cents: 1234,
      amount_usd_cents: 1234,
      transactions: {
        origin: "0xorigintx456",
        booking: "0xbookingtx123",
      },
      status: "paid",
    });
    expect(typeof ev.data.timestamp).toBe("string");
  });

  it("webhook_delivery_receiver_verifies_signature_and_accepts_payload", async () => {
    const h = harness();
    await createCheckout(h, { order_ref: "ORD-RCV-1", amount_usd: "50.00" });
    const store = createMemoryStores().api;
    const secret = "whsec_shopify_secret_123";
    store.saveWebhookEndpoint(ACME, {
      id: "whe_shopify",
      url: "https://shop.example/webhooks/openrail",
      secret,
      events: ["checkout.paid"],
    });

    let receivedPayload: Record<string, unknown> | null = null;
    let signatureVerified = false;

    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rawSig = headers["Openrail-Signature"] ?? "";
      const body = String(init?.body ?? "");

      // Documented verification algorithm:
      // Openrail-Signature: t=<timestamp>,v1=<hmac-sha256(secret, t + "." + body)>
      const parsed = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(rawSig);
      if (parsed) {
        const t = Number(parsed[1]);
        const expected = signWebhook(secret, t, body);
        if (rawSig === expected) {
          signatureVerified = true;
          receivedPayload = JSON.parse(body);
          return new Response("OK", { status: 200 });
        }
      }
      return new Response("Unauthorized", { status: 401 });
    });

    const worker = new WebhookWorker({
      events: stream([
        event(1, "checkout_paid", "c-101", {
          order_ref: "ORD-RCV-1",
          booking_tx: "0xbook999",
          origin_tx: "0xorig888",
        }),
      ]),
      store,
      fetchImpl,
      validateUrl: async () => undefined,
      clock: () => NOW,
      expand: (e) => expandEvents(e, [h.module], h.context()),
    });

    await worker.runOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signatureVerified).toBe(true);
    expect(receivedPayload).toMatchObject({
      type: "checkout.paid",
      data: {
        checkout_id: "c-101",
        order_ref: "ORD-RCV-1",
        amount_cents: 5000,
        transactions: {
          booking: "0xbook999",
          origin: "0xorig888",
        },
      },
    });
  });

  it("finished_checkout_is_read_from_chain_and_indexer_once_across_multiple_reads", async () => {
    let indexerReceiptCalls = 0;
    const mockIndexer: NonNullable<ApiDeps["indexer"]> = {
      listEvents: async () => ({ data: [], next_cursor: null }),
      listReceipts: async () => {
        indexerReceiptCalls += 1;
        return [{ tx_hash: "0x123", amount: "2000000" }];
      },
    } as unknown as NonNullable<ApiDeps["indexer"]>;

    const h = harness({ indexer: mockIndexer });
    const { body: created } = await createCheckout(h, { order_ref: "ORD-SETTLE-1" });
    const id = created.id;

    // Simulate payment on chain
    h.chain.claims.set(id, claimView({ token_id: id, booked_total: "2000000", status: "Paid" }));

    // Reset spy counts before reading
    h.claimSpy.mockClear();
    h.checkoutStateSpy.mockClear();
    indexerReceiptCalls = 0;

    // First read: reads from chain and indexer, and settles into docs NS_SETTLED
    const r1 = await call(h, "GET", `/v1/checkouts/${id}`, undefined, h.keys.acme);
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe("paid");
    expect(h.claimSpy).toHaveBeenCalledTimes(1);
    expect(h.checkoutStateSpy).toHaveBeenCalledTimes(1);
    expect(indexerReceiptCalls).toBe(1);

    // Subsequent API reads: served from NS_SETTLED copy, chain & indexer NOT called again
    const r2 = await call(h, "GET", `/v1/checkouts/${id}`, undefined, h.keys.acme);
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe("paid");
    expect(h.claimSpy).toHaveBeenCalledTimes(1);
    expect(h.checkoutStateSpy).toHaveBeenCalledTimes(1);
    expect(indexerReceiptCalls).toBe(1);

    // Public /v1/public/checkouts/<id> read: also served from settled copy
    const r3 = await call(h, "GET", `/v1/public/checkouts/${id}`);
    expect(r3.status).toBe(200);
    expect(r3.body.status).toBe("paid");
    expect(h.claimSpy).toHaveBeenCalledTimes(1);
    expect(h.checkoutStateSpy).toHaveBeenCalledTimes(1);
    expect(indexerReceiptCalls).toBe(1);
  });

  it("open_checkout_is_read_from_chain_again_on_each_read", async () => {
    const h = harness();
    const { body: created } = await createCheckout(h, { order_ref: "ORD-OPEN-1" });
    const id = created.id;

    h.claimSpy.mockClear();
    h.checkoutStateSpy.mockClear();

    // First read when pending
    const r1 = await call(h, "GET", `/v1/checkouts/${id}`, undefined, h.keys.acme);
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe("pending");
    expect(h.claimSpy).toHaveBeenCalledTimes(1);

    // Second read when still pending: chain is read again so live state updates can be seen
    const r2 = await call(h, "GET", `/v1/checkouts/${id}`, undefined, h.keys.acme);
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe("pending");
    expect(h.claimSpy).toHaveBeenCalledTimes(2);
  });

  it("late_payment_with_held_amount_counts_as_open_until_accepted_or_refunded", async () => {
    const h = harness();
    const { body: created } = await createCheckout(h, { order_ref: "ORD-LATE-1" });
    const id = created.id;

    // Past expiry, but state has late: true, held_amount > 0, not yet accepted/refunded
    h.advance(20 * 60 * 1000);
    h.chain.states.set(id, {
      expiry: Math.floor(NOW.getTime() / 1000) + 900,
      late: true,
      held_amount: "2000000",
      accepted: false,
      refunded: false,
      order_ref: "ORD-LATE-1",
    });

    h.claimSpy.mockClear();
    // Read 1: in late open state
    const r1 = await call(h, "GET", `/v1/checkouts/${id}`, undefined, h.keys.acme);
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe("late");
    expect(h.claimSpy).toHaveBeenCalledTimes(1);

    // Read 2: still open (not settled), reads chain again
    const r2 = await call(h, "GET", `/v1/checkouts/${id}`, undefined, h.keys.acme);
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe("late");
    expect(h.claimSpy).toHaveBeenCalledTimes(2);

    // Now accept the late payment -> accepted
    h.chain.states.set(id, {
      expiry: Math.floor(NOW.getTime() / 1000) + 900,
      late: true,
      held_amount: "0",
      accepted: true,
      refunded: false,
      order_ref: "ORD-LATE-1",
    });

    const r3 = await call(h, "GET", `/v1/checkouts/${id}`, undefined, h.keys.acme);
    expect(r3.status).toBe(200);
    expect(r3.body.status).toBe("accepted");
    expect(h.claimSpy).toHaveBeenCalledTimes(3);

    // Advance past settle grace -> now it settles
    h.advance(3600 * 1000);
    const r4 = await call(h, "GET", `/v1/checkouts/${id}`, undefined, h.keys.acme);
    expect(r4.status).toBe(200);
    expect(r4.body.status).toBe("accepted");
    expect(h.claimSpy).toHaveBeenCalledTimes(4);

    // Read 5: settled! No new chain read
    const r5 = await call(h, "GET", `/v1/checkouts/${id}`, undefined, h.keys.acme);
    expect(r5.status).toBe(200);
    expect(r5.body.status).toBe("accepted");
    expect(h.claimSpy).toHaveBeenCalledTimes(4);
  });

  it("hosted_page_and_api_return_checking_status_when_chain_cannot_be_read", async () => {
    // A checkout that was never read and cannot be read now: "checking", never a 500.
    const failingChain: CheckoutChain = {
      claim: async () => {
        throw new Error("RPC network timeout");
      },
      checkoutState: async () => {
        throw new Error("RPC rate limit exceeded");
      },
      paymentLog: async () => [],
    };
    const h = harness({ chain: failingChain });
    const { body: created } = await createCheckout(h, { order_ref: "ORD-RPC-1" });
    const id = created.id;
    const r2 = await call(h, "GET", `/v1/checkouts/${id}`, undefined, h.keys.acme);
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe("checking");
    const r3 = await call(h, "GET", `/v1/public/checkouts/${id}`);
    expect(r3.status).toBe(200);
    expect(r3.body.status).toBe("checking");
    expect(r3.body.order_ref).toBe("ORD-RPC-1");
  });

  it("a partial payment stays partial when the chain cannot be read for a moment (the page flapped between partial, checking and waiting)", async () => {
    let failChain = false;
    const flaky: CheckoutChain = {
      claim: async (token) => {
        if (failChain) throw new Error("RPC rate limit exceeded");
        return claimView({ token_id: token, booked_total: "1000000" });
      },
      checkoutState: async () => {
        if (failChain) throw new Error("RPC rate limit exceeded");
        return null;
      },
      paymentLog: async () => [],
    };
    const h = harness({ chain: flaky });
    const { body: created } = await createCheckout(h, { order_ref: "ORD-RPC-2" });
    const id = created.id;
    expect((await call(h, "GET", `/v1/checkouts/${id}`, undefined, h.keys.acme)).body.status).toBe(
      "partial",
    );
    failChain = true;
    for (let i = 0; i < 5; i += 1) {
      const r = await call(h, "GET", `/v1/public/checkouts/${id}`);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("partial");
    }
  });

  it("shopify_app_replay_creates_retries_and_delivers_signed_webhooks_matching_contract", async () => {
    const h = harness();
    const store = createMemoryStores().api;
    const webhookSecret = "whsec_shopify_replay_test";
    store.saveWebhookEndpoint(ACME, {
      id: "whe_shopify_1",
      url: "https://my-app.example/shopify/webhooks/openrail",
      secret: webhookSecret,
      events: ["checkout.paid", "checkout.paid_late", "checkout.partial", "checkout.accepted"],
    });

    // 1. Initial checkout creation by Shopify app
    const shopifyCreatePayload = {
      order_ref: "shopify-6001002003",
      amount_usd: "12.00",
      currency: "USD",
      expires_in_minutes: 60,
      return_url: "https://my-store.myshopify.com/checkouts/c/123/complete",
      cancel_url: "https://my-store.myshopify.com/checkouts/c/123/cancel",
      fee_mode: "pass_to_customer",
      items: [{ name: "Widget A", quantity: 1, unit_price_usd: "12.00" }],
    };

    const rCreate = await call(h, "POST", "/v1/checkouts", shopifyCreatePayload, h.keys.acme, {
      "idempotency-key": "shopify-order-6001002003-session-gid-1",
    });
    expect(rCreate.status).toBe(201);
    const checkout = rCreate.body;
    expect(checkout.id).toBe("c-101");
    expect(checkout.token_id).toBe("c-101");
    expect(checkout.order_ref).toBe("shopify-6001002003");
    expect(checkout.amount_usd).toBe("12.03");
    expect(checkout.subtotal_usd).toBe("12.00");
    expect(checkout.fee_usd).toBe("0.03");
    expect(checkout.total_usd).toBe("12.03");
    expect(checkout.fee_mode).toBe("pass_to_customer");
    expect(checkout.pay_url).toBe("https://pay.example/c/c-101");
    expect(checkout.return_url).toBe("https://my-store.myshopify.com/checkouts/c/123/complete");
    expect(checkout.cancel_url).toBe("https://my-store.myshopify.com/checkouts/c/123/cancel");
    expect(checkout.status).toBe("pending");

    // 2. Repeat session for the same order_ref and amount -> 200 with existing checkout
    const rRepeat = await call(h, "POST", "/v1/checkouts", shopifyCreatePayload, h.keys.acme, {
      "idempotency-key": "shopify-order-6001002003-session-gid-2",
    });
    expect(rRepeat.status).toBe(200);
    expect(rRepeat.body.id).toBe(checkout.id);
    expect(rRepeat.body.order_ref).toBe("shopify-6001002003");

    // 3. Different amount for existing order_ref -> 409 order_ref_amount_mismatch
    const rConflict = await call(
      h,
      "POST",
      "/v1/checkouts",
      { ...shopifyCreatePayload, amount_usd: "24.00" },
      h.keys.acme,
      { "idempotency-key": "shopify-order-6001002003-session-gid-3" },
    );
    expect(rConflict.status).toBe(409);
    expect(rConflict.body.error?.code).toBe("order_ref_amount_mismatch");

    // 4. Non-USD currency -> 400 unsupported_currency
    const rEur = await call(
      h,
      "POST",
      "/v1/checkouts",
      { ...shopifyCreatePayload, order_ref: "shopify-eur-order", currency: "EUR" },
      h.keys.acme,
      { "idempotency-key": "shopify-eur-key" },
    );
    expect(rEur.status).toBe(400);
    expect(rEur.body.error?.code).toBe("unsupported_currency");

    // 5. Webhook delivery: simulate indexed checkout_paid event
    const deliveredWebhooks: Array<{ url: string; headers: Record<string, string>; body: string }> =
      [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      deliveredWebhooks.push({
        url: String(url),
        headers: (init?.headers as Record<string, string>) ?? {},
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const stream = (rows: IndexedEvent[]): NonNullable<ApiDeps["indexer"]> =>
      ({
        listEvents: async () => ({ data: rows, next_cursor: null }),
      }) as unknown as NonNullable<ApiDeps["indexer"]>;

    const paidEvent: IndexedEvent = {
      id: "1",
      type: "checkout_paid",
      created: Math.floor(NOW.getTime() / 1000),
      data: {
        token_id: "c-101",
        booking_tx: "8fJ3kLmN9pQrStUvWxYz",
        origin_tx: "0xabc123def456",
      },
      indexed: true,
    };

    const worker = new WebhookWorker({
      events: stream([paidEvent]),
      store,
      fetchImpl,
      validateUrl: async () => undefined,
      clock: () => NOW,
      expand: (e) => expandEvents(e, [h.module], h.context()),
    });
    await worker.runOnce();
    expect(deliveredWebhooks).toHaveLength(1);
    const delivered = deliveredWebhooks[0]!;
    expect(delivered.url).toBe("https://my-app.example/shopify/webhooks/openrail");

    // Verify Openrail-Signature header
    const sigHeader =
      delivered.headers["Openrail-Signature"] ?? delivered.headers["openrail-signature"];
    expect(sigHeader).toBeDefined();
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sigHeader ?? "");
    expect(match).not.toBeNull();
    const ts = Number(match![1]);
    expect(sigHeader).toBe(signWebhook(webhookSecret, ts, delivered.body));

    // Verify payload shape expected by ag6's Shopify app
    const eventPayload = JSON.parse(delivered.body) as {
      id: string;
      type: string;
      data: Record<string, unknown>;
    };
    expect(eventPayload.type).toBe("checkout.paid");
    expect(eventPayload.data.token_id).toBe("c-101");
    expect(eventPayload.data.order_ref).toBe("shopify-6001002003");
    expect(eventPayload.data.status).toBe("paid");
    expect(eventPayload.data.subtotal_usd).toBe("12.00");
    expect(eventPayload.data.fee_usd).toBe("0.03");
    expect(eventPayload.data.total_usd).toBe("12.03");
    expect(eventPayload.data.amount_usd).toBe("12.03");
    expect(eventPayload.data.booking_tx).toBe("8fJ3kLmN9pQrStUvWxYz");
    expect(eventPayload.data.origin_tx).toBe("0xabc123def456");

    // 6. Webhook delivery: simulate indexed checkout_paid_late event
    const lateEvent: IndexedEvent = {
      id: "2",
      type: "checkout_paid_late",
      created: Math.floor(NOW.getTime() / 1000) + 10,
      data: {
        token_id: "c-101",
        held_amount: "12030000",
      },
      indexed: true,
    };
    const workerLate = new WebhookWorker({
      events: stream([lateEvent]),
      store,
      fetchImpl,
      validateUrl: async () => undefined,
      clock: () => NOW,
      expand: (e) => expandEvents(e, [h.module], h.context()),
    });
    await workerLate.runOnce();
    expect(deliveredWebhooks).toHaveLength(2);
    const deliveredLate = deliveredWebhooks[1]!;
    const latePayload = JSON.parse(deliveredLate.body) as {
      type: string;
      data: Record<string, unknown>;
    };
    expect(latePayload.type).toBe("checkout.paid_late");
    expect(latePayload.data.status).toBe("late");
    expect(latePayload.data.order_ref).toBe("shopify-6001002003");
    expect(latePayload.data.amount_usd).toBe("12.03");
  });

  async function withTwoForWebhook() {
    const h = harness();
    await createCheckout(h, { order_ref: "ORD-1" });
    return h;
  }
});
