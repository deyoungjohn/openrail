import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
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
    "invoices:write",
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
  const deps: ApiDeps = {
    config,
    auth,
    issuer,
    contract,
    accessKey: { has: async () => true },
    cashout: { quote: async () => ({ deposit_address: "0xdeposit" }) },
    quoteProvider,
    clock,
    spec: { openapi: "3.1.0" },
    webhookFetch: async () => new Response("ok", { status: 200 }),
  };
  return { app: new ApiApp(deps), auth, secret, issuer, contract, quoteProvider };
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
    headers: { authorization: `Bearer ${secret}`, ...headers },
    body,
  };
}

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
    const { app, secret, issuer, quoteProvider } = harness();
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
