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
    contract: {
      intentsHasPublicKey: vi.fn(async () => true),
    } as never,
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
  return { app, request, apiKey: secret, deps };
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
        signed_data: { standard: "nep413", public_key: "ed25519:11111111111111111111111111111111" },
      }),
    );
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ intentHash: "intent-1" });
  });

  it("reads whether the session account registered the signing key on intents.near", async () => {
    const { app, request, deps } = await harness();
    const key = "ed25519:11111111111111111111111111111111";
    const registered = vi.fn(async () => true);
    (deps.contract as unknown as { intentsHasPublicKey: typeof registered }).intentsHasPublicKey =
      registered;
    const response = await app.handle({
      ...request("GET", "/v1/balance/confidential/key"),
      query: new URLSearchParams({ public_key: key }),
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ registered: true });
    expect(registered).toHaveBeenCalledWith("merchant.near", key);

    const bad = await app.handle({
      ...request("GET", "/v1/balance/confidential/key"),
      query: new URLSearchParams({ public_key: "not-a-key" }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: { code: "invalid_public_key" } });
  });

  it("reads the business's intents.near balance on the server, so the browser needs no RPC", async () => {
    const { app, request, deps } = await harness();
    const read = vi.fn(async () => [{ token_id: USDC, amount: "9974051" }]);
    (deps.contract as unknown as { intentsBalances: typeof read }).intentsBalances = read;
    const response = await app.handle(request("GET", "/v1/balance/intents"));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ balances: [{ token_id: USDC, amount: "9974051" }] });
    expect(read).toHaveBeenCalledWith("merchant.near");
  });

  it("answers 503 balance_unavailable when the chain read fails", async () => {
    const { app, request, deps } = await harness();
    (deps.contract as unknown as { intentsBalances: () => Promise<never> }).intentsBalances =
      async () => {
        throw new Error("RPC_NETWORK");
      };
    const response = await app.handle(request("GET", "/v1/balance/intents"));
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: "balance_unavailable" } });
  });

  it("refuses a signed intent whose key is not registered before calling the provider", async () => {
    const { app, request, deps } = await harness();
    const submitIntent = vi.fn(async () => ({ intentHash: "must-not-run" }));
    (deps.confidential as unknown as { submitIntent: typeof submitIntent }).submitIntent =
      submitIntent;
    (
      deps.contract as unknown as { intentsHasPublicKey: () => Promise<boolean> }
    ).intentsHasPublicKey = async () => false;
    const response = await app.handle(
      request("POST", "/v1/balance/confidential/withdraw/submit", {
        signed_data: { standard: "nep413", public_key: "ed25519:11111111111111111111111111111111" },
      }),
    );
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: "intents_key_not_registered" } });
    expect(submitIntent).not.toHaveBeenCalled();
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

describe("private balance session payload (versioned nonce, as the CLI)", () => {
  it("builds the empty intent with magic, V1, salt, deadline and start time in the nonce", async () => {
    const { confidentialAuthPayload } = await import("./confidential-auth.js");
    const now = Date.parse("2026-11-13T08:00:00.500Z");
    const p = confidentialAuthPayload("merchant.near", "a1b2c3d4", now, new Uint8Array(7).fill(9));
    expect(p.standard).toBe("nep413");
    expect(p.payload.recipient).toBe("intents.near");
    expect(JSON.parse(p.payload.message)).toEqual({
      deadline: "2026-11-13T08:04:00.000Z",
      intents: [],
      signer_id: "merchant.near",
    });
    const nonce = Buffer.from(p.payload.nonce, "base64");
    expect(nonce.length).toBe(32);
    expect(nonce.subarray(0, 4).toString("hex")).toBe("5628f6c6");
    expect(nonce[4]).toBe(0);
    expect(nonce.subarray(5, 9).toString("hex")).toBe("a1b2c3d4");
    expect(nonce.readBigInt64LE(9)).toBe(
      BigInt(Date.parse("2026-11-13T08:04:00.000Z")) * 1_000_000n,
    );
    expect(nonce.readBigInt64LE(17)).toBe(BigInt(now) * 1_000_000n);
    expect([...nonce.subarray(25)]).toEqual([9, 9, 9, 9, 9, 9, 9]);
  });

  it("serves the payload for the signed-in merchant with the contract's salt", async () => {
    const { app, request, deps } = await harness();
    (deps.confidential as { currentSalt?: () => Promise<string> }).currentSalt = async () =>
      "0badf00d";
    const r = await app.handle(request("GET", "/v1/balance/confidential/auth-payload"));
    expect(r.status).toBe(200);
    const body = r.body as { payload: { message: string; nonce: string } };
    expect(JSON.parse(body.payload.message).signer_id).toBe("merchant.near");
    expect(Buffer.from(body.payload.nonce, "base64").subarray(5, 9).toString("hex")).toBe(
      "0badf00d",
    );
  });
});

describe("withdrawals started here are listed with their explorer links", () => {
  it("records the quote, keeps the provider's links, and hides a price nobody signed", async () => {
    const { app, request, deps } = await harness();
    const status = deps.confidential?.withdrawStatus as ReturnType<typeof vi.fn>;
    status.mockResolvedValue({
      status: "SUCCESS",
      swapDetails: {
        amountOut: "995000",
        destinationChainTxHashes: [
          { hash: "0x00d4e1e3f08", explorerUrl: "https://basescan.org/tx/0x00d4e1e3f08" },
        ],
        nearTxHashes: [{ hash: "NearHash1", explorerUrl: "" }],
      },
    });
    await app.handle(
      request("POST", "/v1/balance/confidential/withdraw/quote", {
        amount: "1000000",
        source_asset: USDC,
        destination_chain: "base",
        address: "0x" + "e".repeat(40),
      }),
    );
    const list = await app.handle(request("GET", "/v1/balance/confidential/withdrawals"));
    expect(list.status).toBe(200);
    const rows = (list.body as { data: Record<string, unknown>[] }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deposit_address: "withdraw-deposit",
      amount: "1000000",
      status: "SUCCESS",
      amount_out: "995000",
      destination_tx_hashes: ["0x00d4e1e3f08"],
      destination_explorer_urls: ["https://basescan.org/tx/0x00d4e1e3f08"],
      near_tx_hashes: ["NearHash1"],
    });

    status.mockResolvedValue({ status: "PENDING_DEPOSIT" });
    (deps.confidential?.withdrawQuote as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      quote: { depositAddress: "never-signed" },
    });
    await app.handle(
      request("POST", "/v1/balance/confidential/withdraw/quote", {
        amount: "2000000",
        source_asset: USDC,
        destination_chain: "base",
        address: "0x" + "e".repeat(40),
      }),
    );
    const again = await app.handle(request("GET", "/v1/balance/confidential/withdrawals"));
    expect((again.body as { data: unknown[] }).data).toHaveLength(1);
  });
});
