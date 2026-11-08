import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
import { isImplicitAccountId, usernameProblem, payLink, ackLink, refOf } from "./links.js";

const BASE_TIME = Date.parse("2026-11-02T10:00:00Z");

function createHarness(initialTimeMs = BASE_TIME) {
  let currentTime = initialTimeMs;
  const clock = () => new Date(currentTime);
  const setTime = (ms: number) => {
    currentTime = ms;
  };
  const advanceTime = (ms: number) => {
    currentTime += ms;
  };

  const auth = new AuthStore(() => currentTime);
  const namedAccount = "belmonte.near";
  const { secret: namedSecret } = auth.createApiKey(namedAccount, "Production", "secret", [
    "invoices:read",
    "invoices:write",
  ]);

  const implicitAccount = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const { secret: implicitSecret } = auth.createApiKey(implicitAccount, "Production", "secret", [
    "invoices:read",
    "invoices:write",
  ]);

  const otherAccount = "other.near";
  const { secret: otherSecret } = auth.createApiKey(otherAccount, "Production", "secret", [
    "invoices:read",
    "invoices:write",
  ]);

  const issuer = {
    prepareIssue: vi.fn(async () => ({ tokenId: "c-100", claimAccount: "c-100.openrail.near" })),
    issueFor: vi.fn(async () => ({ txHash: "0xissue100" })),
    logQuote: vi.fn(async () => ({ txHash: "0xquote100" })),
    acknowledgeEvm: vi.fn(async () => ({ txHash: "0xack100", ack: {} })),
  };

  const contract = {
    claim: vi.fn(async () => ({
      token_id: "c-100",
      kind: 0,
      claim_account: "c-100.openrail.near",
      terms_hash: "0x" + "b".repeat(64),
      amount_due: "50000000",
      outstanding: "50000000",
      status: "Issued",
    })),
    storageCredit: vi.fn(async () => ({
      balance: "5000000000000000000000000",
      amount: "1000000000000000000000000",
    })),
    sponsorStatus: vi.fn(async () => ({ pool: "5000000000000000000000000", cap: 5, used: 1 })),
  };

  const quoteProvider = {
    quote: vi.fn(async (request: { amount: string }) => ({
      quoteId: "q_1",
      depositAddress: "0xdeposit",
      deadline: "2026-11-03T10:00:00Z",
      amountIn: request.amount,
      amountOut: request.amount,
      spreadBps: 0,
    })),
    status: vi.fn(async () => ({ status: "PENDING_DEPOSIT" })),
  };

  const cashout = {
    quote: vi.fn(async (request: { refundTo: string }) => ({
      deposit_address: "0xdeposit",
      refund_to: request.refundTo,
    })),
  };

  const pokeIndexer = vi.fn(async () => undefined);

  const deps: ApiDeps = {
    config: {
      rootAccount: "openrail.near",
      recipient: "api.openrail.near",
      payBaseUrl: "https://pay.openrail.near",
    },
    auth,
    pokeIndexer,
    issuer,
    contract,
    accessKey: { has: async () => true },
    verifier: () => true,
    cashout,
    quoteProvider,
    clock,
    spec: { openapi: "3.1.0" },
    webhookFetch: async () => new Response("ok", { status: 200 }),
    webhookUrlValidator: async () => undefined,
  };

  return {
    app: new ApiApp(deps),
    auth,
    namedAccount,
    namedSecret,
    implicitAccount,
    implicitSecret,
    otherAccount,
    otherSecret,
    setTime,
    advanceTime,
    clock,
  };
}

function req(
  method: string,
  path: string,
  secret: string,
  body?: unknown,
  query?: Record<string, string>,
) {
  const searchParams = new URLSearchParams(query);
  return {
    method,
    path,
    query: searchParams,
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    body,
  };
}

function getErrorCode(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    if (typeof b.error === "object" && b.error !== null) {
      return (b.error as { code?: string }).code;
    }
    return (b.code ?? b.error) as string | undefined;
  }
  return undefined;
}

function getErrorDetails(body: unknown): Record<string, unknown> | undefined {
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    if (typeof b.error === "object" && b.error !== null) {
      return b.error as Record<string, unknown>;
    }
    return b;
  }
  return undefined;
}

const sampleInvoice = {
  invoice_number: "INV-USERNAME-01",
  issuer_legal_name: "Test Issuer",
  debtor_legal_name: "Test Debtor",
  debtor_key: "debtor.openrail.near",
  amount_usd: "50.00",
  due_date: "2026-12-01",
};

describe("Business Username Specification (prompts/ag3.md update 27)", () => {
  describe("1. Identity Model: display name, username, and NEAR account are three distinct things", () => {
    it("returns account_id, legal_name, and username as distinct fields on GET /v1/business", async () => {
      const h = createHarness();
      const res = await h.app.handle(req("GET", "/v1/business", h.namedSecret));
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty("account_id", h.namedAccount);
      expect(body).toHaveProperty("legal_name", h.namedAccount);
      expect(body).toHaveProperty("username", h.namedAccount);
      expect(body).not.toHaveProperty("username_changed_at");
    });

    it("allows legal_name (display name) to contain free text, spaces, and punctuation without affecting username", async () => {
      const h = createHarness();
      const res = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, {
          legal_name: "Belmonte Apparels & Co. (Global)",
        }),
      );
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.legal_name).toBe("Belmonte Apparels & Co. (Global)");
      expect(body.username).toBe(h.namedAccount);
    });
  });

  describe("2. Automatic Username Assignment and Implicit Accounts", () => {
    it("automatically sets username to account_id for a named NEAR account on first request", async () => {
      const h = createHarness();
      const res = await h.app.handle(req("GET", "/v1/business", h.namedSecret));
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.username).toBe("belmonte.near");
    });

    it("assigns username: null for an implicit 64-hex account on first request", async () => {
      const h = createHarness();
      const res = await h.app.handle(req("GET", "/v1/business", h.implicitSecret));
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.account_id).toBe(h.implicitAccount);
      expect(body.username).toBeNull();
    });

    it("correctly identifies 64-hex strings as implicit accounts", () => {
      expect(
        isImplicitAccountId("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
      ).toBe(true);
      expect(
        isImplicitAccountId("0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"),
      ).toBe(true);
      expect(isImplicitAccountId("alice.near")).toBe(false);
      expect(isImplicitAccountId("0123456789abcdef")).toBe(false);
    });
  });

  describe("3. Validation Rules and Reserved Names", () => {
    it("enforces length between 3 and 32 characters", () => {
      expect(usernameProblem("ab", "alice.near")).toBe("invalid");
      expect(usernameProblem("a", "alice.near")).toBe("invalid");
      expect(usernameProblem("abc", "alice.near")).toBeNull();
      expect(usernameProblem("a".repeat(32), "alice.near")).toBeNull();
      expect(usernameProblem("a".repeat(33), "alice.near")).toBe("invalid");
    });

    it("enforces charset [a-z0-9_-]", () => {
      expect(usernameProblem("valid-user_123", "alice.near")).toBeNull();
      expect(usernameProblem("user name", "alice.near")).toBe("invalid");
      expect(usernameProblem("user@name", "alice.near")).toBe("invalid");
      expect(usernameProblem("user!name", "alice.near")).toBe("invalid");
    });

    it("requires username to start and end with a letter or digit", () => {
      expect(usernameProblem("-alice", "alice.near")).toBe("invalid");
      expect(usernameProblem("_alice", "alice.near")).toBe("invalid");
      expect(usernameProblem("alice-", "alice.near")).toBe("invalid");
      expect(usernameProblem("alice_", "alice.near")).toBe("invalid");
      expect(usernameProblem("1alice2", "alice.near")).toBeNull();
    });

    it("forbids two separators in a row (-- , __ , -_ , _-)", () => {
      expect(usernameProblem("al--ice", "alice.near")).toBe("invalid");
      expect(usernameProblem("al__ice", "alice.near")).toBe("invalid");
      expect(usernameProblem("al-_ice", "alice.near")).toBe("invalid");
      expect(usernameProblem("al_-ice", "alice.near")).toBe("invalid");
      expect(usernameProblem("al-i_ce", "alice.near")).toBeNull();
    });

    it("rejects reserved top-level names (3-32 chars)", () => {
      const reservedList = [
        "app",
        "pay",
        "ack",
        "inv",
        "statement",
        "login",
        "setup",
        "docs",
        "admin",
        "www",
        "help",
        "support",
        "openrail",
        "near",
        "settings",
        "invoices",
      ];
      for (const name of reservedList) {
        expect(usernameProblem(name, "alice.near")).toBe("reserved");
      }
    });

    it("verifies behavior of short or underscore-prefixed reserved names", () => {
      // Finding for ag4: 'r', 'c', 'v1' are in RESERVED set but return 'invalid' due to length < 3 check preceding RESERVED check.
      // '_next' and '_dev' return 'invalid' due to leading underscore check preceding RESERVED check.
      expect(usernameProblem("r", "alice.near")).toBe("invalid");
      expect(usernameProblem("c", "alice.near")).toBe("invalid");
      expect(usernameProblem("v1", "alice.near")).toBe("invalid");
      expect(usernameProblem("_next", "alice.near")).toBe("invalid");
      expect(usernameProblem("_dev", "alice.near")).toBe("invalid");
    });

    it("enforces the dot rule: dot is ONLY allowed when it is exactly the caller's own NEAR account ID", () => {
      // Own account ID matches -> valid
      expect(usernameProblem("belmonte.near", "belmonte.near")).toBeNull();
      expect(usernameProblem("alice.near", "alice.near")).toBeNull();

      // Dot present but does not match caller account ID -> invalid (prevent squatting acme.near)
      expect(usernameProblem("acme.near", "belmonte.near")).toBe("invalid");
      expect(usernameProblem("other.near", "belmonte.near")).toBe("invalid");
      expect(usernameProblem("foo.bar", "belmonte.near")).toBe("invalid");
    });

    it("rejects invalid usernames in PUT /v1/business with 400 invalid_username", async () => {
      const h = createHarness();
      // Too short
      const res1 = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { username: "ab" }),
      );
      expect(res1.status).toBe(400);
      expect(getErrorCode(res1.body)).toBe("invalid_username");

      // Reserved
      const res2 = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { username: "support" }),
      );
      expect(res2.status).toBe(400);
      expect(getErrorCode(res2.body)).toBe("invalid_username");

      // Squatting someone else's dotted name
      const res3 = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { username: "acme.near" }),
      );
      expect(res3.status).toBe(400);
      expect(getErrorCode(res3.body)).toBe("invalid_username");
    });
  });

  describe("4. Username Availability Route: GET /v1/business/username_available", () => {
    it("returns { available: true, reason: 'available' } for an unused valid username", async () => {
      const h = createHarness();
      const res = await h.app.handle(
        req("GET", "/v1/business/username_available", h.namedSecret, undefined, { u: "brand-new" }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: true, reason: "available" });
    });

    it("returns { available: false, reason: 'invalid' } for invalid syntax or dotted name of another account", async () => {
      const h = createHarness();
      const res1 = await h.app.handle(
        req("GET", "/v1/business/username_available", h.namedSecret, undefined, { u: "x" }),
      );
      expect(res1.status).toBe(200);
      expect(res1.body).toEqual({ available: false, reason: "invalid" });

      const res2 = await h.app.handle(
        req("GET", "/v1/business/username_available", h.namedSecret, undefined, { u: "acme.near" }),
      );
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual({ available: false, reason: "invalid" });
    });

    it("returns { available: false, reason: 'reserved' } for reserved route names", async () => {
      const h = createHarness();
      const res = await h.app.handle(
        req("GET", "/v1/business/username_available", h.namedSecret, undefined, { u: "docs" }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: false, reason: "reserved" });
    });

    it("returns { available: false, reason: 'taken' } for a username already held by another business", async () => {
      const h = createHarness();
      // other.near takes "other-handle"
      await h.app.handle(req("PUT", "/v1/business", h.otherSecret, { username: "other-handle" }));

      // namedAccount checks "other-handle"
      const res = await h.app.handle(
        req("GET", "/v1/business/username_available", h.namedSecret, undefined, {
          u: "other-handle",
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: false, reason: "taken" });
    });

    it("never says 'taken' for a name the caller already holds", async () => {
      const h = createHarness();
      // namedAccount already has "belmonte.near"
      const res1 = await h.app.handle(
        req("GET", "/v1/business/username_available", h.namedSecret, undefined, {
          u: "belmonte.near",
        }),
      );
      expect(res1.status).toBe(200);
      expect(res1.body).toEqual({ available: true, reason: "available" });

      // namedAccount sets handle "belmonte"
      await h.app.handle(req("PUT", "/v1/business", h.namedSecret, { username: "belmonte" }));
      const res2 = await h.app.handle(
        req("GET", "/v1/business/username_available", h.namedSecret, undefined, { u: "belmonte" }),
      );
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual({ available: true, reason: "available" });
    });
  });

  describe("5. Case-Insensitive Uniqueness", () => {
    it("refuses taken username case-insensitively with 409 username_taken", async () => {
      const h = createHarness();
      // otherAccount takes "superstore"
      const res1 = await h.app.handle(
        req("PUT", "/v1/business", h.otherSecret, { username: "superstore" }),
      );
      expect(res1.status).toBe(200);

      // namedAccount tries to take "SuperStore"
      const res2 = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { username: "SuperStore" }),
      );
      expect(res2.status).toBe(409);
      expect(getErrorCode(res2.body)).toBe("username_taken");
    });

    it("allows the owner to re-save its own username idempotently", async () => {
      const h = createHarness();
      await h.app.handle(req("PUT", "/v1/business", h.namedSecret, { username: "myhandle" }));
      const res = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { username: "MyHandle" }),
      );
      expect(res.status).toBe(200);
      expect((res.body as { username: string }).username).toBe("myhandle");
    });
  });

  describe("6. Independent Updates via PUT /v1/business", () => {
    it("updates legal_name without modifying existing username", async () => {
      const h = createHarness();
      await h.app.handle(req("PUT", "/v1/business", h.namedSecret, { username: "custom-handle" }));

      const res = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { legal_name: "Brand New Display Name" }),
      );
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.legal_name).toBe("Brand New Display Name");
      expect(body.username).toBe("custom-handle");
    });

    it("updates username without modifying legal_name", async () => {
      const h = createHarness();
      await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { legal_name: "Original Legal Name" }),
      );

      const res = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { username: "new-handle-1" }),
      );
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.legal_name).toBe("Original Legal Name");
      expect(body.username).toBe("new-handle-1");
    });
  });

  describe("7. 30-Day Change Limit and Delayed Release", () => {
    it("limits username changes to once every 30 days with 429 username_change_too_soon", async () => {
      const h = createHarness();
      // First change: from default "belmonte.near" to "belmonte"
      const res1 = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { username: "belmonte" }),
      );
      expect(res1.status).toBe(200);

      // Attempt second change 1 day later (86400 seconds)
      h.advanceTime(24 * 60 * 60 * 1000);
      const res2 = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { username: "belmonte-new" }),
      );
      expect(res2.status).toBe(429);
      expect(getErrorCode(res2.body)).toBe("username_change_too_soon");
      const details = getErrorDetails(res2.body);
      expect(details?.allowed_at).toBeDefined();

      // Verify allowed_at is approximately 29 days in the future
      const allowedTime = Date.parse(details!.allowed_at as string);
      expect(allowedTime).toBe(BASE_TIME + 30 * 24 * 60 * 60 * 1000);

      // Advance time past 30 days
      h.setTime(BASE_TIME + 30 * 24 * 60 * 60 * 1000 + 1000);
      const res3 = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { username: "belmonte-new" }),
      );
      expect(res3.status).toBe(200);
      expect((res3.body as { username: string }).username).toBe("belmonte-new");
    });

    it("delays the release of the previous username for 30 days", async () => {
      const h = createHarness();
      // otherAccount changes username to "first-handle"
      await h.app.handle(req("PUT", "/v1/business", h.otherSecret, { username: "first-handle" }));

      // 31 days pass so otherAccount can change again
      h.advanceTime(31 * 24 * 60 * 60 * 1000);

      // otherAccount changes username to "second-handle", releasing "first-handle" with a 30-day delay
      const res1 = await h.app.handle(
        req("PUT", "/v1/business", h.otherSecret, { username: "second-handle" }),
      );
      expect(res1.status).toBe(200);

      // 5 days later, namedAccount tries to claim "first-handle"
      h.advanceTime(5 * 24 * 60 * 60 * 1000);
      const resAvail = await h.app.handle(
        req("GET", "/v1/business/username_available", h.namedSecret, undefined, {
          u: "first-handle",
        }),
      );
      expect(resAvail.body).toEqual({ available: false, reason: "taken" });

      const resClaim = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { username: "first-handle" }),
      );
      expect(resClaim.status).toBe(409);
      expect(getErrorCode(resClaim.body)).toBe("username_taken");

      // 26 more days pass (total > 30 days since release)
      h.advanceTime(26 * 24 * 60 * 60 * 1000);
      const resAvailAfter = await h.app.handle(
        req("GET", "/v1/business/username_available", h.namedSecret, undefined, {
          u: "first-handle",
        }),
      );
      expect(resAvailAfter.body).toEqual({ available: true, reason: "available" });

      // namedAccount can now successfully claim the released name
      const resClaimAfter = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { username: "first-handle" }),
      );
      expect(resClaimAfter.status).toBe(200);
      expect((resClaimAfter.body as { username: string }).username).toBe("first-handle");
    });
  });

  describe("8. Invoice Issuing Guard: 409 username_required", () => {
    it("refuses invoice creation when business has no username (implicit account)", async () => {
      const h = createHarness();
      // Implicit account has username: null initially
      const res = await h.app.handle(req("POST", "/v1/invoices", h.implicitSecret, sampleInvoice));
      expect(res.status).toBe(409);
      expect(getErrorCode(res.body)).toBe("username_required");
    });

    it("allows invoice creation after implicit account sets a username", async () => {
      const h = createHarness();
      // Set username
      const putRes = await h.app.handle(
        req("PUT", "/v1/business", h.implicitSecret, { username: "implicit-user" }),
      );
      expect(putRes.status).toBe(200);

      // Now create invoice
      const res = await h.app.handle(req("POST", "/v1/invoices", h.implicitSecret, sampleInvoice));
      expect(res.status).toBe(201);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty("id");
    });
  });

  describe("9. Pay and Acceptance Links Format", () => {
    it("formats pay_link and ack_url using the business username and ref", async () => {
      const h = createHarness();
      await h.app.handle(req("PUT", "/v1/business", h.namedSecret, { username: "belmonte" }));

      const res = await h.app.handle(req("POST", "/v1/invoices", h.namedSecret, sampleInvoice));
      expect(res.status).toBe(201);
      const body = res.body as { id: string; pay_link: string; ack_url: string };

      const ref = refOf(body.id);
      expect(ref).not.toMatch(/^inv_/);
      expect(body.pay_link).toBe(`https://pay.openrail.near/belmonte/inv/${ref}`);
      expect(body.ack_url).toBe(`https://pay.openrail.near/belmonte/inv/ack/${ref}`);
    });

    it("verifies link helper functions directly", () => {
      expect(payLink("https://pay.openrail.near", "belmonte", "abc12345")).toBe(
        "https://pay.openrail.near/belmonte/inv/abc12345",
      );
      expect(ackLink("https://pay.openrail.near", "belmonte", "abc12345")).toBe(
        "https://pay.openrail.near/belmonte/inv/ack/abc12345",
      );
      expect(refOf("inv_1234abcd")).toBe("1234abcd");
    });
  });

  describe("10. Link Persistence Across Username Renames", () => {
    it("allows fetching invoice by ref after the business changes its username", async () => {
      const h = createHarness();
      await h.app.handle(req("PUT", "/v1/business", h.namedSecret, { username: "old-handle" }));

      const createRes = await h.app.handle(
        req("POST", "/v1/invoices", h.namedSecret, sampleInvoice),
      );
      expect(createRes.status).toBe(201);
      const invoice = createRes.body as { id: string };
      const ref = refOf(invoice.id);

      // Advance 31 days to allow username change
      h.advanceTime(31 * 24 * 60 * 60 * 1000);
      const renameRes = await h.app.handle(
        req("PUT", "/v1/business", h.namedSecret, { username: "new-handle" }),
      );
      expect(renameRes.status).toBe(200);

      // Fetch by original id
      const fetchById = await h.app.handle(req("GET", `/v1/invoices/${invoice.id}`, h.namedSecret));
      expect(fetchById.status).toBe(200);

      // Fetch by ref (without inv_ prefix)
      const fetchByRef = await h.app.handle(req("GET", `/v1/invoices/${ref}`, h.namedSecret));
      expect(fetchByRef.status).toBe(200);
      const invoiceData = (fetchByRef.body as { invoice?: { id: string } }).invoice;
      expect(invoiceData?.id).toBe(invoice.id);
    });
  });
});
