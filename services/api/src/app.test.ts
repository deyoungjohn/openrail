import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps, ApiError } from "./app.js";
import { AuthStore } from "./auth.js";
import { UnsafeWebhookUrl } from "./webhook-url.js";
import { termsHash } from "./terms.js";

const clock = () => new Date("2026-11-02T10:00:00Z");
const config = {
  rootAccount: "openrail.near",
  recipient: "api.openrail.near",
  payBaseUrl: "https://pay.openrail.near",
};

function harness() {
  const auth = new AuthStore(() => clock().getTime());
  const { secret } = auth.createApiKey("acme.openrail.near", "Production", "secret", [
    "invoices:read",
    "invoices:write",
    "payments:read",
    "receipts:read",
    "webhooks:write",
  ]);
  const issuer = {
    prepareIssue: vi.fn(async () => ({ tokenId: "c-1", claimAccount: "c-1.openrail.near" })),
    issueFor: vi.fn(async () => ({ txHash: "0xissue" })),
    logQuote: vi.fn(async () => ({ txHash: "0xquote" })),
    acknowledgeEvm: vi.fn(async ({ chainId }: { chainId: number }) => ({
      txHash: "0xack",
      ack: { scheme: { Evm: { chain_id: chainId, signer: "0x" + "e".repeat(40) } }, block: 7 },
    })),
  };
  const contract = {
    claim: vi.fn(async () => ({
      token_id: "c-1",
      kind: 0,
      claim_account: "c-1.openrail.near",
      terms_hash: "0x" + "a".repeat(64),
      amount_due: "12500000",
      outstanding: "12500000",
      status: "Issued",
    })),
    storageCredit: vi.fn(async () => ({
      balance: "5000000000000000000000000",
      amount: "1000000000000000000000000",
    })),
    sponsorStatus: vi.fn(async () => ({ pool: "5000000000000000000000000", cap: 5, used: 1 })),
  };
  const quoteProvider = {
    quote: vi.fn(async (request: { amount: string; deadline: string }) => ({
      quoteId: "q_1",
      depositAddress: "0xdeposit",
      deadline: "2026-11-03T10:00:00Z",
      amountIn: request.amount,
      amountOut: request.amount,
      spreadBps: 0,
    })),
  };
  const pokeIndexer = vi.fn(async () => undefined);
  const deps: ApiDeps = {
    config,
    auth,
    pokeIndexer,
    issuer,
    contract,
    accessKey: { has: async () => true },
    verifier: () => true,
    cashout: { quote: async () => ({ deposit_address: "0xdeposit" }) },
    quoteProvider,
    clock,
    spec: { openapi: "3.1.0" },
    webhookFetch: async () => new Response("ok", { status: 200 }),
    webhookUrlValidator: async (url: string) => {
      if (!url.startsWith("https://")) throw new UnsafeWebhookUrl("webhook URL must use https");
    },
  };
  return { app: new ApiApp(deps), auth, secret, issuer, contract, quoteProvider, pokeIndexer };
}

function request(
  method: string,
  path: string,
  body: unknown,
  secret: string,
  headers: Record<string, string> = {},
) {
  return {
    method,
    path,
    query: new URLSearchParams(),
    headers: { ...(secret === "" ? {} : { authorization: `Bearer ${secret}` }), ...headers },
    body,
  };
}

afterEach(() => {
  delete process.env.WEB_ORIGIN;
  delete process.env.COOKIE_DOMAIN;
});

const invoiceBody = {
  invoice_number: "INV-2026-001",
  issuer_legal_name: "Acme Ltd",
  debtor_legal_name: "Debtor Co",
  debtor_key: "debtor.openrail.near",
  amount_usd: "12.50",
  due_date: "2026-12-01",
  line_items: [{ description: "Design", quantity: 1, unit_amount_usd: "12.50" }],
};

describe("invoice route", () => {
  it("canonicalises terms, hashes them, issues, and stores the invoice", async () => {
    const { app, secret, issuer } = harness();
    const response = await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    expect(response.status).toBe(201);
    const body = response.body as {
      token_id: string;
      terms_hash: string;
      terms: { due_date: string };
    };
    expect(body.token_id).toBe("c-1");
    expect(body.terms.due_date).toBe("2026-12-01T00:00:00Z");
    expect(body.terms_hash).toBe(termsHash(body.terms as never));
    expect(issuer.issueFor).toHaveBeenCalledWith(
      expect.objectContaining({ business: "acme.openrail.near", termsHash: body.terms_hash }),
    );
  });

  it("returns the first response for the same idempotency key and body", async () => {
    const { app, secret } = harness();
    const first = await app.handle(
      request("POST", "/v1/invoices", invoiceBody, secret, { "idempotency-key": "key-12345678" }),
    );
    const second = await app.handle(
      request("POST", "/v1/invoices", invoiceBody, secret, { "idempotency-key": "key-12345678" }),
    );
    expect(second).toEqual(first);

    const conflict = await app.handle(
      request("POST", "/v1/invoices", { ...invoiceBody, amount_usd: "13.00" }, secret, {
        "idempotency-key": "key-12345678",
      }),
    );
    expect(conflict.status).toBe(409);
    expect((conflict.body as { error: { code: string } }).error.code).toBe("idempotency_key_reuse");
  });

  it("refuses a non-https webhook URL at registration", async () => {
    const { app, secret } = harness();
    const response = await app.handle(
      request(
        "POST",
        "/v1/webhook_endpoints",
        { url: "http://169.254.169.254/latest/meta-data/", events: ["invoice.paid"] },
        secret,
      ),
    );
    expect(response.status).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe("invalid_webhook_url");
  });

  it("returns own credit, sponsor pool and remaining sponsored invoices", async () => {
    const { app, secret } = harness();
    const response = await app.handle(
      request("GET", "/v1/business/storage_credit", undefined, secret),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      balance: "5000000000000000000000000",
      sponsor: { pool: "5000000000000000000000000", cap: 5, used: 1, remaining: 4 },
    });
  });

  it("still answers the credit route when sponsor_status is missing", async () => {
    const { app, secret, contract } = harness();
    contract.sponsorStatus = vi.fn(async () => {
      throw new Error("Method sponsor_status is not found");
    });
    const response = await app.handle(
      request("GET", "/v1/business/storage_credit", undefined, secret),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ balance: "5000000000000000000000000" });
    expect((response.body as { sponsor?: unknown }).sponsor).toBeUndefined();
  });

  it("treats a sponsored invoice as enough credit and reports the remaining count", async () => {
    const { app, secret, issuer } = harness();
    issuer.prepareIssue.mockResolvedValueOnce({
      tokenId: "c-1",
      claimAccount: "c-1.openrail.near",
      storageCredit: "0",
      amount: "20000000000000000000000",
      sponsored: true,
      sponsoredRemaining: 4,
    } as never);
    const sponsored = await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    expect(sponsored.status).toBe(201);

    issuer.prepareIssue.mockResolvedValueOnce({
      tokenId: "c-2",
      claimAccount: "c-2.openrail.near",
      storageCredit: "0",
      amount: "20000000000000000000000",
      sponsored: false,
      sponsoredRemaining: 0,
    } as never);
    const refused = await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    expect(refused.status).toBe(402);
    const error = (refused.body as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("insufficient_storage_credit");
    expect(error.message).toContain("0 sponsored invoices remain");
  });

  it("requires a valid origin-chain refund address for a pay session", async () => {
    const { app, secret } = harness();
    await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    const missing = await app.handle(
      request("POST", "/v1/pay/sessions", { token_id: "c-1", route_id: "R1" }, secret),
    );
    expect(missing.status).toBe(400);
    expect((missing.body as { error: { code: string } }).error.code).toBe("invalid_refund_address");
    const bad = await app.handle(
      request(
        "POST",
        "/v1/pay/sessions",
        { token_id: "c-1", route_id: "R1", refund_to: "0x123" },
        secret,
      ),
    );
    expect(bad.status).toBe(400);
  });

  it("defaults a new secret key to all five scopes", async () => {
    const { app, secret } = harness();
    const response = await app.handle(
      request("POST", "/v1/api_keys", { name: "Production" }, secret),
    );
    expect(response.status).toBe(201);
    expect((response.body as { scopes: string[] }).scopes).toEqual([
      "invoices:read",
      "invoices:write",
      "payments:read",
      "receipts:read",
      "webhooks:write",
    ]);
  });

  it.each([
    { scope: "invoices:read", method: "GET", path: "/v1/invoices", body: undefined, ok: 200 },
    { scope: "invoices:write", method: "POST", path: "/v1/invoices", body: invoiceBody, ok: 201 },
    { scope: "payments:read", method: "GET", path: "/v1/payments", body: undefined, ok: 200 },
    {
      scope: "receipts:read",
      method: "GET",
      path: "/v1/invoices/c-1/receipts",
      body: undefined,
      ok: 200,
    },
    {
      scope: "webhooks:write",
      method: "GET",
      path: "/v1/webhook_endpoints",
      body: undefined,
      ok: 200,
    },
  ])("enforces $scope", async ({ scope, method, path, body, ok }) => {
    const { app, auth, secret } = harness();
    await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    const allowed = auth.createApiKey("acme.openrail.near", "scoped", "secret", [scope]).secret;
    const allowedResponse = await app.handle(request(method, path, body, allowed));
    expect(allowedResponse.status, `${scope} allowed`).toBe(ok);

    const denied = auth.createApiKey("acme.openrail.near", "unscoped", "secret", []).secret;
    const deniedResponse = await app.handle(request(method, path, body, denied));
    expect(deniedResponse.status, `${scope} denied`).toBe(403);
    expect(
      (deniedResponse.body as { error: { code: string; message: string } }).error,
    ).toMatchObject({
      code: "insufficient_scope",
      message: `missing scope: ${scope}`,
    });
  });

  it("requires pay_sessions:create for a publishable pay session", async () => {
    const { app, auth, secret } = harness();
    await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    const publishable = auth.createApiKey("acme.openrail.near", "Pay", "publishable", [
      "pay_sessions:create",
    ]).secret;
    const allowed = await app.handle(
      request(
        "POST",
        "/v1/pay/sessions",
        { token_id: "c-1", route_id: "R1", refund_to: "0x" + "e".repeat(40) },
        publishable,
      ),
    );
    expect(allowed.status).toBe(201);

    const unscoped = auth.createApiKey("acme.openrail.near", "Pay2", "publishable", []).secret;
    const denied = await app.handle(
      request(
        "POST",
        "/v1/pay/sessions",
        { token_id: "c-1", route_id: "R1", refund_to: "0x" + "e".repeat(40) },
        unscoped,
      ),
    );
    expect(denied.status).toBe(403);
    expect((denied.body as { error: { code: string } }).error.code).toBe("insufficient_scope");
  });

  it("pokes the indexer after a cash-out quote", async () => {
    const { app, secret, pokeIndexer } = harness();
    const response = await app.handle(
      request(
        "POST",
        "/v1/cashout/quote",
        { amount: "2000000", destination_chain: "base", address: "0x" + "e".repeat(40) },
        secret,
      ),
    );
    expect(response.status).toBe(201);
    expect(pokeIndexer).toHaveBeenCalledTimes(1);
  });

  it("lists payments for the business", async () => {
    const { app, secret } = harness();
    app.store.savePayment("pay_1", {
      id: "pay_1",
      invoice_id: "inv_1",
      amount: "12500000",
      origin_chain: "base",
      origin_asset: "nep141:usdc",
      status: "success",
      booked_at: "2026-11-02T10:00:00Z",
    });
    const response = await app.handle(request("GET", "/v1/payments", undefined, secret));
    expect(response.status).toBe(200);
    expect((response.body as { data: { id: string }[] }).data[0]?.id).toBe("pay_1");
  });

  it("adds kind_rules to the claim view", async () => {
    const { app, secret } = harness();
    await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    const response = await app.handle(request("GET", "/v1/invoices/c-1", undefined, secret));
    expect(response.status).toBe(200);
    const claim = (response.body as { claim: { kind_rules: unknown } }).claim;
    expect(claim.kind_rules).toEqual({
      ack_required_for_sale: true,
      sellable: true,
      quote_deadline: 3600,
      debtor_optional: false,
    });
  });

  it("renders the invoice PDF", async () => {
    const { app, secret } = harness();
    await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    const response = await app.handle(request("GET", "/v1/invoices/c-1/pdf", undefined, secret));
    expect(response.status).toBe(200);
    const body = response.body as { content_type: string; content_base64: string };
    expect(body.content_type).toBe("application/pdf");
    expect(Buffer.from(body.content_base64, "base64").toString("latin1")).toContain("INV-2026-001");
  });
});

describe("pay session route", () => {
  it("returns deadline_requested and the provider deadline after log_quote", async () => {
    const { app, secret, issuer, quoteProvider, pokeIndexer } = harness();
    await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    const response = await app.handle(
      request(
        "POST",
        "/v1/pay/sessions",
        { token_id: "c-1", route_id: "R1", refund_to: "0x" + "e".repeat(40) },
        secret,
      ),
    );
    expect(response.status).toBe(201);
    const body = response.body as {
      deadline_requested: number;
      deadline: string;
      deposit_address: string;
    };
    expect(body.deadline_requested).toBe(Date.parse("2026-11-02T10:00:00Z") / 1000 + 3600);
    expect(body.deadline).toBe("2026-11-03T10:00:00Z");
    expect(body.deposit_address).toBe("0xdeposit");
    expect(quoteProvider.quote).toHaveBeenCalled();
    expect(issuer.logQuote).toHaveBeenCalled();
    expect(pokeIndexer).toHaveBeenCalledTimes(1);
  });
});

describe("EVM acknowledgement relay", () => {
  it("relays a supported chain signature", async () => {
    const { app, secret, issuer } = harness();
    await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    const response = await app.handle(
      request("POST", "/v1/ack/c-1/evm", { chain_id: 8453, signature: "0xsig" }, secret),
    );
    expect(response.status).toBe(200);
    expect((response.body as { tx_hash: string }).tx_hash).toBe("0xack");
    expect(issuer.acknowledgeEvm).toHaveBeenCalledWith({
      tokenId: "c-1",
      chainId: 8453,
      signature: "0xsig",
    });
  });

  it("rejects an unsupported chain before calling the issuer", async () => {
    const { app, secret, issuer } = harness();
    await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    const response = await app.handle(
      request("POST", "/v1/ack/c-1/evm", { chain_id: 999, signature: "0xsig" }, secret),
    );
    expect(response.status).toBe(422);
    expect(issuer.acknowledgeEvm).not.toHaveBeenCalled();
  });
});

describe("webhooks route", () => {
  it("creates, lists (without secret), tests and logs a delivery", async () => {
    const { app, secret } = harness();
    const created = await app.handle(
      request(
        "POST",
        "/v1/webhook_endpoints",
        { url: "https://example.com/hook", events: ["invoice.paid"] },
        secret,
      ),
    );
    expect(created.status).toBe(201);
    const endpoint = created.body as { id: string; secret: string };
    expect(endpoint.secret.startsWith("whsec_")).toBe(true);

    const listed = await app.handle(request("GET", "/v1/webhook_endpoints", undefined, secret));
    expect(JSON.stringify(listed.body)).not.toContain(endpoint.secret);

    const tested = await app.handle(
      request("POST", `/v1/webhook_endpoints/${endpoint.id}/test`, {}, secret),
    );
    expect(tested.status).toBe(200);
    const deliveries = await app.handle(
      request("GET", `/v1/webhook_endpoints/${endpoint.id}/deliveries`, undefined, secret),
    );
    expect(deliveries.status).toBe(200);
  });
});

describe("session cookie", () => {
  it("sets an HttpOnly session cookie, reads it and logs out", async () => {
    process.env.WEB_ORIGIN = "http://localhost:3000";
    process.env.COOKIE_DOMAIN = "openrail.incepture.dev";
    const { app } = harness();
    const challenge = await app.handle(
      request("POST", "/v1/auth/challenge", { account_id: "acme.openrail.near" }, ""),
    );
    const nonce = (challenge.body as { nonce: string }).nonce;
    const verified = await app.handle(
      request(
        "POST",
        "/v1/auth/verify",
        {
          account_id: "acme.openrail.near",
          public_key: "ed25519:example",
          signature: "sig",
          nonce,
        },
        "",
      ),
    );
    expect(verified.status).toBe(200);
    const cookie = String(verified.headers?.["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Domain=openrail.incepture.dev");
    const token = /or_sess=([^;]+)/.exec(cookie)?.[1] ?? "";

    const session = await app.handle(
      request("GET", "/v1/auth/session", undefined, "", { cookie: `or_sess=${token}` }),
    );
    expect(session.status).toBe(200);
    expect((session.body as { account_id: string }).account_id).toBe("acme.openrail.near");

    const logout = await app.handle(
      request("POST", "/v1/auth/logout", {}, "", {
        cookie: `or_sess=${token}`,
        origin: "http://localhost:3000",
        "content-type": "application/json",
      }),
    );
    expect(logout.status).toBe(200);
    const after = await app.handle(
      request("GET", "/v1/auth/session", undefined, "", { cookie: `or_sess=${token}` }),
    );
    expect(after.status).toBe(401);
  });

  it("rejects a cookie-authenticated state change with no allowed Origin (CSRF)", async () => {
    process.env.WEB_ORIGIN = "http://localhost:3000";
    const { app, auth } = harness();
    const challenge = auth.challenge("acme.openrail.near", "api.openrail.near");
    const session = await auth.verify(
      {
        accountId: "acme.openrail.near",
        publicKey: "ed25519:example",
        signature: "sig",
        nonce: challenge.nonce,
      },
      () => true,
      async () => true,
    );
    const response = await app.handle(
      request("POST", "/v1/invoices", invoiceBody, "", {
        cookie: `or_sess=${session.sessionToken}`,
        "content-type": "application/json",
      }),
    );
    expect(response.status).toBe(403);
    expect((response.body as { error: { code: string } }).error.code).toBe("csrf_origin");
  });
});

describe("health route", () => {
  it("answers without auth", async () => {
    const { app } = harness();
    const response = await app.handle(request("GET", "/v1/health", undefined, ""));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, mock: false });
  });
});

describe("meta route", () => {
  it("serves the OpenAPI document", async () => {
    const { app } = harness();
    const response = await app.handle(request("GET", "/v1/openapi.json", undefined, ""));
    expect(response.status).toBe(200);
    expect((response.body as { openapi: string }).openapi).toBe("3.1.0");
  });
});

describe("auth route", () => {
  it("challenges and verifies a dashboard session", async () => {
    const { app } = harness();
    const challenge = await app.handle(
      request("POST", "/v1/auth/challenge", { account_id: "acme.openrail.near" }, ""),
    );
    expect(challenge.status).toBe(200);
    const body = challenge.body as { nonce: string; message: string; recipient: string };
    expect(body.recipient).toBe("api.openrail.near");
    expect(body.message).toContain("acme.openrail.near");
  });
});

describe("invoice route: the issuer handshake", () => {
  it("passes the id it predicted so the issuer can refuse a mint that took another", async () => {
    const { app, secret, issuer } = harness();
    await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    expect(issuer.issueFor).toHaveBeenCalledWith(
      expect.objectContaining({ expectedTokenId: "c-1" }),
    );
  });

  it("answers 402 insufficient_storage_credit, and issues nothing, when the business has no credit", async () => {
    const { app, secret, issuer } = harness();
    issuer.prepareIssue.mockResolvedValueOnce({
      tokenId: "c-1",
      claimAccount: "c-1.openrail.near",
      storageCredit: "0",
      amount: "20000000000000000000000",
      account: "openrail.near",
    } as never);
    const response = await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    expect(response.status).toBe(402);
    expect((response.body as { error: { code: string; message: string } }).error.code).toBe(
      "insufficient_storage_credit",
    );
    expect((response.body as { error: { message: string } }).error.message).toContain(
      "openrail.near",
    );
    expect(issuer.issueFor).not.toHaveBeenCalled();
  });

  it("retries once with the corrected id when the mint took another", async () => {
    const { app, secret, issuer } = harness();
    issuer.prepareIssue
      .mockResolvedValueOnce({ tokenId: "c-5", claimAccount: "c-5.openrail.near" } as never)
      .mockResolvedValueOnce({ tokenId: "c-7", claimAccount: "c-7.openrail.near" } as never);
    issuer.issueFor
      .mockRejectedValueOnce(new ApiError(409, "token_id_mismatch"))
      .mockResolvedValueOnce({ txHash: "0xissue" });
    const response = await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    expect(response.status).toBe(201);
    expect((response.body as { token_id: string }).token_id).toBe("c-7");
    expect(issuer.issueFor).toHaveBeenCalledTimes(2);
  });

  it("gives up with 409 after a second mismatch", async () => {
    const { app, secret, issuer } = harness();
    issuer.issueFor.mockRejectedValue(new ApiError(409, "token_id_mismatch"));
    const response = await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    expect(response.status).toBe(409);
    expect(issuer.issueFor).toHaveBeenCalledTimes(2);
  });

  it("says so when the issuer does not report the next claim id (an old issuer service)", async () => {
    const { app, secret, issuer } = harness();
    issuer.prepareIssue.mockResolvedValueOnce({
      account: "openrail.near",
      amount: "1",
      storageCredit: "9",
    } as never);
    const response = await app.handle(request("POST", "/v1/invoices", invoiceBody, secret));
    expect(response.status).toBe(502);
    expect((response.body as { error: { code: string } }).error.code).toBe("issuer_outdated");
  });
});
