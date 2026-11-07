import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
import { claimLabel } from "./links.js";

const invoice = {
  invoice_number: "INV-1",
  issuer_legal_name: "Belmonte Apparels",
  debtor_legal_name: "Client",
  debtor_key: "client.near",
  amount_usd: "12.50",
  due_date: "2026-12-01",
  line_items: [],
};

function harness(claimLabels: boolean) {
  const auth = new AuthStore(() => Date.parse("2026-11-08T10:00:00Z"));
  const { secret } = auth.createApiKey("acme.near", "Production", "secret", [
    "invoices:read",
    "invoices:write",
  ]);
  const issuer = {
    prepareIssue: vi.fn<ApiDeps["issuer"]["prepareIssue"]>(async () => ({
      storageCredit: "999",
      amount: "1",
    })),
    issueFor: vi.fn(async (request: { claimLabel?: string }) => ({
      txHash: "0xissue",
      tokenId: request.claimLabel ?? "c-1",
      claimAccount: `${request.claimLabel ?? "c-1"}.openrail.near`,
    })),
    logQuote: vi.fn(),
    acknowledgeEvm: vi.fn(),
  };
  const deps: ApiDeps = {
    config: {
      rootAccount: "openrail.near",
      recipient: "api.near",
      payBaseUrl: "https://pay.test",
      claimLabels,
    },
    auth,
    issuer,
    contract: {
      claim: vi.fn(async () => ({ status: "Issued", amount_due: "12500000" })),
      storageCredit: vi.fn(async () => ({ balance: "999", amount: "1" })),
    } as never,
    accessKey: { has: async () => true },
    cashout: { quote: vi.fn(async () => ({})) },
    verifier: () => true,
    clock: () => new Date("2026-11-08T10:00:00Z"),
  };
  const app = new ApiApp(deps);
  const request = (method: string, path: string, body?: unknown) => ({
    method,
    path,
    query: new URLSearchParams(),
    headers: { authorization: `Bearer ${secret}` },
    body,
  });
  return { app, request, issuer };
}

describe("claim labels", () => {
  it("uses the username and invoice ref", () => {
    expect(claimLabel("belmonte", "9f3c2a7d41b86e0c15")).toBe("belmonte-9f3c2a7d41b8");
    expect(claimLabel("belmonte.studio", "9f3c2a7d41b86e0c15")).toBe(
      "belmonte-studio-9f3c2a7d41b8",
    );
    expect(claimLabel("belmonte_studio", "9f3c2a7d41b86e0c15")).toBe(
      "belmonte-studio-9f3c2a7d41b8",
    );
    expect(claimLabel("a".repeat(40), "9f3c2a7d41b86e0c15")).toBe(`${"a".repeat(32)}-9f3c2a7d41b8`);
  });

  it("builds the terms with the label before asking the issuer", async () => {
    const { app, request, issuer } = harness(true);
    await app.handle(request("PUT", "/v1/business", { username: "belmonte" }));
    const response = await app.handle(request("POST", "/v1/invoices", invoice));
    expect(response.status).toBe(201);
    const body = response.body as {
      id: string;
      token_id: string;
      claim_account: string;
      terms: { claim_account: string };
      pay_link: string;
      ack_url: string;
    };
    const label = claimLabel("belmonte", body.id.replace(/^inv_/, ""));
    expect(body.token_id).toBe(label);
    expect(body.claim_account).toBe(`${label}.openrail.near`);
    expect(body.terms.claim_account).toBe(`${label}.openrail.near`);
    expect(body.pay_link).toMatch(/^https:\/\/pay\.test\/belmonte\/inv\/[0-9a-f]+$/);
    expect(body.ack_url).toMatch(/^https:\/\/pay\.test\/belmonte\/inv\/ack\/[0-9a-f]+$/);
    expect(issuer.issueFor).toHaveBeenCalledWith(expect.objectContaining({ claimLabel: label }));
    expect(issuer.issueFor.mock.calls[0]?.[0]).not.toHaveProperty("expectedTokenId");
  });

  it("keeps the numbered flow while the flag is off", async () => {
    const { app, request, issuer } = harness(false);
    const response = await app.handle(request("POST", "/v1/invoices", invoice));
    expect(response.status).toBe(502);
    expect((response.body as { error: { code: string } }).error.code).toBe("issuer_outdated");

    issuer.prepareIssue.mockResolvedValueOnce({
      tokenId: "c-1",
      claimAccount: "c-1.openrail.near",
      storageCredit: "999",
      amount: "1",
    });
    const created = await app.handle(request("POST", "/v1/invoices", invoice));
    expect(created.status).toBe(201);
    expect((created.body as { token_id: string }).token_id).toBe("c-1");
    expect(issuer.issueFor).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedTokenId: "c-1" }),
    );
    expect(issuer.issueFor.mock.calls.at(-1)?.[0]).not.toHaveProperty("claimLabel");
  });
});
