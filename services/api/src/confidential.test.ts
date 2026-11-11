import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
import { createCashoutPort } from "./defaults.js";
import { createMemoryStores } from "./stores.js";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

describe("confidential cash-out quote", () => {
  it("builds the shield quote with the merchant as recipient", async () => {
    const quote = vi.fn(async () => ({
      quote: { amountOut: "1000000", depositAddress: "shield-deposit" },
    }));
    const port = createCashoutPort({ quote } as never);
    const result = await port.quote({
      amount: "1000000",
      destinationChain: "confidential",
      address: "merchant.near",
      refundTo: "merchant.near",
      sourceAsset: USDC,
    });
    expect(quote).toHaveBeenCalledWith(
      expect.objectContaining({
        originAsset: USDC,
        destinationAsset: USDC,
        swapType: "EXACT_INPUT",
        depositType: "INTENTS",
        refundType: "INTENTS",
        recipientType: "CONFIDENTIAL_INTENTS",
        recipient: "merchant.near",
        refundTo: "merchant.near",
        dry: false,
      }),
    );
    expect(result).toMatchObject({
      destination_chain: "confidential",
      destination_address: "merchant.near",
      route_id: "confidential",
      deposit_address: "shield-deposit",
    });
  });
});

function harness() {
  const stores = createMemoryStores();
  const auth = new AuthStore(() => Date.parse("2026-11-10T10:00:00Z"));
  const { secret } = auth.createApiKey("merchant.near", "Production", "secret", ["payments:read"]);
  const deps: ApiDeps = {
    config: {
      rootAccount: "openrail.near",
      recipient: "api.near",
      payBaseUrl: "https://pay.test",
      confidentialIntents: true,
    },
    store: stores.api,
    docs: stores.docs,
    auth,
    issuer: {
      prepareIssue: vi.fn(),
      issueFor: vi.fn(),
      logQuote: vi.fn(),
      acknowledgeEvm: vi.fn(),
    } as never,
    contract: {} as never,
    accessKey: { has: async () => true },
    cashout: { quote: vi.fn() },
    confidential: {
      authenticate: vi.fn(async () => ({ accessToken: "user-token", expiresIn: 300 })),
      balances: vi.fn(async () => [{ tokenId: USDC, available: "2500000", source: "private" }]),
      withdrawQuote: vi.fn(async () => ({ quote: { depositAddress: "withdraw-deposit" } })),
      generateIntent: vi.fn(async () => ({
        intent: { standard: "nep413", payload: { message: "{}" } },
      })),
      submitIntent: vi.fn(async () => ({ intentHash: "intent-1" })),
      withdrawStatus: vi.fn(async () => ({ status: "SUCCESS" })),
    },
    clock: () => new Date("2026-11-10T10:00:00Z"),
  };
  const app = new ApiApp(deps);
  const request = (method: string, path: string, body?: unknown) => ({
    method,
    path,
    query: new URLSearchParams(),
    headers: { authorization: `Bearer ${secret}` },
    body,
  });
  return { app, request };
}

describe("confidential balance", () => {
  it("requires a user session and then reads the private balance", async () => {
    const { app, request } = harness();
    expect((await app.handle(request("GET", "/v1/balance/confidential"))).status).toBe(409);
    const session = await app.handle(
      request("POST", "/v1/balance/confidential/session", { signed_data: { standard: "nep413" } }),
    );
    expect(session.status).toBe(200);
    const balance = await app.handle(request("GET", "/v1/balance/confidential"));
    expect(balance.status).toBe(200);
    expect(balance.body).toEqual({
      source: "private",
      balances: [{ token_id: USDC, available: "2500000", source: "private" }],
    });
  });
});

describe("confidential withdraw", () => {
  it("quotes, generates the intent, submits the signature and reports status", async () => {
    const { app, request } = harness();
    const quote = await app.handle(
      request("POST", "/v1/balance/confidential/withdraw/quote", {
        amount: "500000",
        source_asset: USDC,
        destination_chain: "base",
        address: "0x" + "e".repeat(40),
      }),
    );
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ quote: { depositAddress: "withdraw-deposit" } });

    const intent = await app.handle(
      request("POST", "/v1/balance/confidential/withdraw/intent", {
        deposit_address: "withdraw-deposit",
      }),
    );
    expect(intent.status).toBe(200);
    expect(intent.body).toMatchObject({ intent: { standard: "nep413" } });

    const submitted = await app.handle(
      request("POST", "/v1/balance/confidential/withdraw/submit", {
        signed_data: { standard: "nep413" },
      }),
    );
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ intentHash: "intent-1" });
  });
});
