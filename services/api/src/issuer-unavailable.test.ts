import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
import { createMemoryStores } from "./stores.js";
import { issuerFailure, issuerUnavailableError } from "./defaults.js";

function harness() {
  const stores = createMemoryStores();
  const store = stores.api;
  store.saveInvoice({
    id: "inv_1",
    token_id: "c-1",
    claim_account: "c-1.openrail.near",
    status: "Issued",
    issuer_id: "acme.near",
    owner_id: "acme.near",
    debtor: { Near: "client.near" },
    terms_hash: "0x" + "a".repeat(64),
    amount_due: "12000000",
    outstanding: "12000000",
    paid_total: "0",
    amount_usd: "12.00",
    due_date: "2026-12-01",
    invoice_number: "INV-1",
    issuer_legal_name: "Acme",
    debtor_legal_name: "Client",
    pay_link: "https://pay.test/acme/inv/1",
    ack_url: "https://pay.test/acme/inv/ack/1",
    created_at: "2026-11-09T10:00:00Z",
    created_block: 1,
    terms: {} as never,
  });
  const auth = new AuthStore(() => Date.parse("2026-11-09T10:00:00Z"));
  const { secret } = auth.createApiKey("acme.near", "Production", "secret", [
    "invoices:read",
    "invoices:write",
    "pay_sessions:create",
  ]);
  const deps: ApiDeps = {
    config: { rootAccount: "openrail.near", recipient: "api.near", payBaseUrl: "https://pay.test" },
    store,
    auth,
    issuer: {
      prepareIssue: vi.fn(),
      issueFor: vi.fn(),
      logQuote: vi.fn(async () => {
        throw issuerUnavailableError(502, "upstream_error");
      }),
      acknowledgeEvm: vi.fn(),
    } as never,
    contract: {
      claim: vi.fn(async () => ({
        kind: 0,
        claim_account: "c-1.openrail.near",
        amount_due: "12000000",
        outstanding: "12000000",
        status: "Issued",
      })),
      storageCredit: vi.fn(),
    } as never,
    cashout: { quote: vi.fn() },
    quoteProvider: {
      quote: vi.fn(async () => ({
        quoteId: "q_1",
        depositAddress: "deposit",
        deadline: "2026-11-09T11:00:00Z",
        amountIn: "12000000",
        amountOut: "12000000",
        spreadBps: 0,
      })),
      status: vi.fn(),
    },
    accessKey: { has: async () => true },
    clock: () => new Date("2026-11-09T10:00:00Z"),
  };
  const request = (method: string, path: string, body?: unknown) => ({
    method,
    path,
    query: new URLSearchParams(),
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body,
  });
  return { app: new ApiApp(deps), store, request };
}

describe("issuer unavailable", () => {
  it("maps a 5xx to 503 issuer_unavailable with retry_after", () => {
    expect(
      issuerFailure(502, JSON.stringify({ error: { code: "upstream_error", message: "down" } })),
    ).toMatchObject({ status: 503, code: "issuer_unavailable", details: { retry_after: 60 } });
  });

  it("pay-session create answers 503 and saves nothing", async () => {
    const { app, store, request } = harness();
    const response = await app.handle(
      request("POST", "/v1/pay/sessions", {
        token_id: "c-1",
        route_id: "R1",
        refund_to: "0x" + "e".repeat(40),
      }),
    );
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: { code: "issuer_unavailable", retry_after: 60 },
    });
    expect(store.listPaySessions("c-1")).toHaveLength(0);
  });
});
