import { describe, expect, it, vi } from "vitest";
import { ApiApp, withdrawPhaseOf, type ApiDeps } from "./app.js";
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

async function harness() {
  const stores = createMemoryStores();
  const auth = new AuthStore(() => Date.parse("2026-11-10T10:00:00Z"));
  const { secret } = auth.createApiKey("merchant.near", "Production", "secret", ["payments:read"]);
  const challenge = auth.challenge("merchant.near", "api.near");
  const session = await auth.verify(
    {
      accountId: "merchant.near",
      publicKey: "ed25519:example",
      signature: "sig",
      nonce: challenge.nonce,
    },
    () => true,
    async () => true,
  );
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
    headers: { authorization: `Bearer ${session.sessionToken}` },
    body,
  });
  return { app, request, apiKey: secret };
}

describe("confidential balance", () => {
  it("requires a user session and then reads the private balance", async () => {
    const { app, request } = await harness();
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
    const { app, request } = await harness();
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

  it("refuses an API key for money-moving preparation", async () => {
    const { app, request, apiKey } = await harness();
    const response = await app.handle({
      ...request("POST", "/v1/balance/confidential/withdraw/quote", {
        amount: "500000",
        source_asset: USDC,
        destination_chain: "base",
        address: "0x" + "e".repeat(40),
      }),
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: "session_required" } });
    for (const [path, body] of [
      ["/v1/balance/confidential/withdraw/intent", { deposit_address: "withdraw-deposit" }],
      ["/v1/balance/confidential/withdraw/submit", { signed_data: { standard: "nep413" } }],
    ] as const) {
      const refused = await app.handle({
        ...request("POST", path, body),
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(refused.status, path).toBe(403);
      expect(refused.body).toMatchObject({ error: { code: "session_required" } });
    }
  });

  it("validates the destination address and amount before quoting", async () => {
    const { app, request } = await harness();
    const badAddress = await app.handle(
      request("POST", "/v1/balance/confidential/withdraw/quote", {
        amount: "500000",
        source_asset: USDC,
        destination_chain: "base",
        address: "0x" + "0".repeat(40),
      }),
    );
    expect(badAddress.status).toBe(400);
    expect(badAddress.body).toMatchObject({ error: { code: "invalid_address" } });
    const badAmount = await app.handle(
      request("POST", "/v1/balance/confidential/withdraw/quote", {
        amount: "10000000001",
        source_asset: USDC,
        destination_chain: "base",
        address: "0x" + "e".repeat(40),
      }),
    );
    expect(badAmount.status).toBe(400);
    expect(badAmount.body).toMatchObject({ error: { code: "invalid_amount" } });
  });
});

describe("confidential withdraw address validation", () => {
  it("accepts a valid address on each supported chain and refuses a bad one", async () => {
    const { app, request } = await harness();
    const valid: Array<[string, string]> = [
      ["base", "0x" + "e".repeat(40)],
      ["arbitrum", "0x" + "e".repeat(40)],
      ["optimism", "0x" + "e".repeat(40)],
      ["polygon", "0x" + "e".repeat(40)],
      ["ethereum", "0x" + "e".repeat(40)],
      ["solana", "11111111111111111111111111111111"],
      ["near", "merchant.near"],
    ];
    for (const [chain, address] of valid) {
      const response = await app.handle(
        request("POST", "/v1/balance/confidential/withdraw/quote", {
          amount: "500000",
          source_asset: USDC,
          destination_chain: chain,
          address,
        }),
      );
      expect(response.status, chain).toBe(200);
    }
    for (const [chain, address] of [
      ["base", "0x1234"],
      ["solana", "not-base58!"],
      ["near", "Invalid Account"],
    ] as Array<[string, string]>) {
      const response = await app.handle(
        request("POST", "/v1/balance/confidential/withdraw/quote", {
          amount: "500000",
          source_asset: USDC,
          destination_chain: chain,
          address,
        }),
      );
      expect(response.status, chain).toBe(400);
      expect((response.body as { error: { code: string } }).error.code).toBe("invalid_address");
    }
  });
});

describe("confidential withdraw status words", () => {
  it("ends only on SUCCESS, REFUNDED or FAILED", () => {
    expect(withdrawPhaseOf("SUCCESS")).toEqual({ phase: "success", terminal: true });
    expect(withdrawPhaseOf("REFUNDED")).toEqual({ phase: "refunded", terminal: true });
    expect(withdrawPhaseOf("FAILED")).toEqual({ phase: "failed", terminal: true });
    for (const word of [
      "PENDING_DEPOSIT",
      "INCOMPLETE_DEPOSIT",
      "KNOWN_DEPOSIT_TX",
      "PROCESSING",
      "NEW_WORD",
    ]) {
      expect(withdrawPhaseOf(word), word).toMatchObject({ terminal: false });
    }
    expect(withdrawPhaseOf("PROCESSING")).toEqual({ phase: "processing", terminal: false });
    expect(withdrawPhaseOf("INCOMPLETE_DEPOSIT")).toEqual({ phase: "pending", terminal: false });
  });

  it("keeps the provider word and adds phase/terminal to the status response", async () => {
    const { app, request } = await harness();
    const response = await app.handle({
      ...request("GET", "/v1/balance/confidential/withdraw/status"),
      query: new URLSearchParams("deposit_address=withdraw-deposit"),
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "SUCCESS", phase: "success", terminal: true });
  });
});
