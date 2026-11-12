import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
import { issuerFailure, rpcBusyError, storageCreditOf } from "./defaults.js";
import { NearQuotaError } from "@openrail/shared";

function harness() {
  const auth = new AuthStore(() => Date.parse("2026-11-09T10:00:00Z"));
  const { secret } = auth.createApiKey("acme.near", "Production", "secret", [
    "invoices:read",
    "invoices:write",
  ]);
  const deps: ApiDeps = {
    config: { rootAccount: "openrail.near", recipient: "api.near", payBaseUrl: "https://pay.test" },
    auth,
    issuer: {
      prepareIssue: vi.fn(async () => {
        throw issuerFailure(
          502,
          JSON.stringify({ error: { code: "upstream_error", message: "RPC_QUOTA_EXCEEDED" } }),
        );
      }),
      issueFor: vi.fn(),
      logQuote: vi.fn(),
      acknowledgeEvm: vi.fn(),
    } as never,
    contract: {
      claim: vi.fn(),
      storageCredit: vi.fn(async () => {
        throw rpcBusyError();
      }),
    } as never,
    accessKey: { has: async () => true },
    cashout: { quote: vi.fn() },
    clock: () => new Date("2026-11-09T10:00:00Z"),
  };
  const request = (method: string, path: string, body?: unknown) => ({
    method,
    path,
    query: new URLSearchParams(),
    headers: { authorization: `Bearer ${secret}` },
    body,
  });
  return { app: new ApiApp(deps), request };
}

describe("RPC quota", () => {
  it("degrades the credit read to 503 rpc_busy", async () => {
    const { app, request } = harness();
    const response = await app.handle(request("GET", "/v1/business/storage_credit"));
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: { code: "rpc_busy", retry_after: expect.any(Number) },
    });
  });

  it("maps an issuer quota failure on create to 503 rpc_busy", async () => {
    const { app, request } = harness();
    const response = await app.handle(
      request("POST", "/v1/invoices", {
        invoice_number: "INV-1",
        issuer_legal_name: "Acme",
        debtor_legal_name: "Client",
        debtor_key: "client.near",
        amount_usd: "12.00",
        due_date: "2026-12-01",
        line_items: [{ description: "Work", quantity: 1, unit_amount_usd: "12.00" }],
      }),
    );
    expect(response.status).toBe(503);
    expect((response.body as { error: { code: string; retry_after: number } }).error).toMatchObject(
      { code: "rpc_busy", retry_after: expect.any(Number) },
    );
  });

  it("storageCreditOf throws the API quota error", async () => {
    await expect(
      storageCreditOf(
        { view: async () => Promise.reject(new NearQuotaError()) } as never,
        "openrail.near",
        "acme.near",
      ),
    ).rejects.toMatchObject({ status: 503, code: "rpc_busy" });
  });
});
