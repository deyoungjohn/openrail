import { describe, expect, it } from "vitest";
import { loadRoutes, type RouteFile } from "@openrail/shared";
import { AddressError, validateRefundAddress } from "./addresses.js";
import {
  ApiApp,
  createStore,
  type ApiDeps,
  type ApiRequest,
  type ContractPort,
  type IssuerPort,
} from "./app.js";
import { AuthStore, hashApiKey } from "./auth.js";
import { hmacSha256Hex } from "./crypto.js";
import { IdempotencyStore } from "./idempotency.js";
import {
  QuoteService,
  isQuoteExpired,
  type QuoteProvider,
  type QuoteProviderRequest,
} from "./quote.js";
import {
  deliverWebhook,
  signWebhook,
  WebhookNotIndexed,
  type IndexedEvent,
  type WebhookEndpointRecord,
} from "./webhooks.js";

function makeFakeContract(overrides: Partial<ContractPort> = {}): ContractPort {
  return {
    claim: async (tokenId: string) => ({
      token_id: tokenId,
      claim_account: `${tokenId}.openrail.near`,
      terms_hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      outstanding: "50000000",
      amount_due: "50000000",
      kind: 0,
      ...overrides,
    }),
    storageCredit: async () => ({ balance: "1000000", amount: "1000000" }),
    ...overrides,
  };
}

function makeFakeIssuer(
  calls: { prepared: string[]; issued: unknown[]; quotesLogged: unknown[] },
  overrides: Partial<IssuerPort> = {},
): IssuerPort {
  let seq = 0;
  return {
    prepareIssue: async () => {
      seq += 1;
      const tokenId = String(seq);
      calls.prepared.push(tokenId);
      return { tokenId, claimAccount: `c${tokenId}.openrail.near` };
    },
    issueFor: async (req) => {
      calls.issued.push(req);
      return { txHash: `tx_issue_${calls.issued.length}` };
    },
    logQuote: async (req) => {
      calls.quotesLogged.push(req);
      return { txHash: `tx_quote_${calls.quotesLogged.length}` };
    },
    acknowledgeEvm: async (req) => ({ txHash: "tx_ack_1", ack: req }),
    ...overrides,
  };
}

function makeApp(
  options: {
    auth?: AuthStore;
    idempotency?: IdempotencyStore;
    issuerOverrides?: Partial<IssuerPort>;
    contractOverrides?: Partial<ContractPort>;
    quoteProvider?: QuoteProvider;
    clock?: () => Date;
    routes?: RouteFile;
  } = {},
) {
  const calls = {
    prepared: [] as string[],
    issued: [] as unknown[],
    quotesLogged: [] as unknown[],
  };
  const auth = options.auth ?? new AuthStore();
  const idempotency = options.idempotency ?? new IdempotencyStore();
  const contract = makeFakeContract(options.contractOverrides);
  const issuer = makeFakeIssuer(calls, options.issuerOverrides);
  const accessKey = {
    has: async () => true,
  };
  const cashout = {
    quote: async () => ({}),
  };
  const deps: ApiDeps = {
    config: {
      rootAccount: "openrail.near",
      recipient: "api.openrail.near",
      payBaseUrl: "https://pay.openrail.org",
    },
    store: createStore(),
    auth,
    idempotency,
    contract,
    issuer,
    accessKey,
    cashout,
    quoteProvider: options.quoteProvider,
    clock: options.clock,
    routes: options.routes,
  };
  const app = new ApiApp(deps);
  return { app, auth, idempotency, calls, deps };
}

describe("Service-level invariant tests (Blueprint 2.8 & 2.11)", () => {
  describe("API and issuance invariants", () => {
    it("idempotency_same_key_same_response", async () => {
      const { app, auth, calls } = makeApp();
      const { secret: sk } = auth.createApiKey("alice.near", "test_sk", "secret", ["admin"]);

      const invoiceBody = {
        invoice_number: "INV-2026-001",
        issuer_legal_name: "Alice Corp",
        debtor_legal_name: "Bob Inc",
        debtor_key: "ed25519:6E8sCci9badyRkXb3JoRpAxnri39Sa3q48sYw19A6U1s",
        amount_usd: "100.00",
        due_date: "2026-12-31",
      };

      const req: ApiRequest = {
        method: "POST",
        path: "/v1/invoices",
        query: new URLSearchParams(),
        headers: {
          authorization: `Bearer ${sk}`,
          "idempotency-key": "idem-first-call-1",
        },
        body: invoiceBody,
      };

      const res1 = await app.handle(req);
      expect(res1.status).toBe(201);
      const invoice1 = res1.body as { id: string; token_id: string; amount_usd: string };
      expect(invoice1.id).toBeDefined();
      expect(calls.issued.length).toBe(1);

      // Second identical request with same Idempotency-Key
      const res2 = await app.handle(req);
      expect(res2.status).toBe(201);
      expect(res2.body).toEqual(res1.body);
      // Contract issueFor port was not called a second time
      expect(calls.issued.length).toBe(1);
    });

    it("idempotency_key_body_mismatch_409", async () => {
      const { app, auth } = makeApp();
      const { secret: sk } = auth.createApiKey("alice.near", "test_sk", "secret", ["admin"]);

      const bodyA = {
        invoice_number: "INV-2026-001",
        issuer_legal_name: "Alice Corp",
        debtor_legal_name: "Bob Inc",
        debtor_key: "ed25519:6E8sCci9badyRkXb3JoRpAxnri39Sa3q48sYw19A6U1s",
        amount_usd: "100.00",
        due_date: "2026-12-31",
      };

      const bodyB = {
        ...bodyA,
        amount_usd: "250.00", // different body
      };

      const res1 = await app.handle({
        method: "POST",
        path: "/v1/invoices",
        query: new URLSearchParams(),
        headers: {
          authorization: `Bearer ${sk}`,
          "idempotency-key": "reused-key-conflict",
        },
        body: bodyA,
      });
      expect(res1.status).toBe(201);

      // Replay same idempotency-key with different payload must fail with 409 Conflict
      const res2 = await app.handle({
        method: "POST",
        path: "/v1/invoices",
        query: new URLSearchParams(),
        headers: {
          authorization: `Bearer ${sk}`,
          "idempotency-key": "reused-key-conflict",
        },
        body: bodyB,
      });
      expect(res2.status).toBe(409);
      expect((res2.body as { error: { code: string } }).error.code).toBe("idempotency_key_reuse");
    });

    it("webhook_signature_verifies", async () => {
      const secret = "whsec_live_abcdef1234567890abcdef1234567890";
      const timestamp = 1793577600;
      const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", created: timestamp });

      const header = signWebhook(secret, timestamp, body);
      expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

      const expectedHmac = hmacSha256Hex(secret, `${timestamp}.${body}`);
      expect(header).toBe(`t=${timestamp},v1=${expectedHmac}`);

      // Tampered payload fails verification
      const tamperedBody = JSON.stringify({
        id: "evt_1",
        type: "invoice.paid",
        created: timestamp,
        extra: 1,
      });
      const tamperedHmac = hmacSha256Hex(secret, `${timestamp}.${tamperedBody}`);
      expect(tamperedHmac).not.toBe(expectedHmac);

      // Tampered timestamp fails verification
      const tamperedTimestampHmac = hmacSha256Hex(secret, `${timestamp + 1}.${body}`);
      expect(tamperedTimestampHmac).not.toBe(expectedHmac);

      // Live delivery test with fetch inspection
      let receivedSignature = "";
      let receivedBody = "";
      const fetchImpl = async (_url: string, init?: RequestInit) => {
        receivedSignature = (init?.headers as Record<string, string>)["Openrail-Signature"] ?? "";
        receivedBody = String(init?.body ?? "");
        return new Response("OK", { status: 200 });
      };

      const endpoint: WebhookEndpointRecord = {
        id: "we_1",
        url: "https://example.com/webhook",
        secret,
        events: ["invoice.paid"],
      };

      const event: IndexedEvent = {
        id: "evt_test",
        type: "invoice.paid",
        created: timestamp,
        data: { token_id: "1" },
        indexed: true,
      };

      const delivery = await deliverWebhook(endpoint, event, {
        fetchImpl,
        clock: () => timestamp * 1000,
      });
      expect(delivery.statusCode).toBe(200);

      // Signature header from deliverWebhook matches HMAC over timestamp + receivedBody
      const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(receivedSignature);
      expect(match).not.toBeNull();
      const t = match![1];
      const sig = match![2];
      expect(sig).toBe(hmacSha256Hex(secret, `${t}.${receivedBody}`));
    });

    it("webhook_only_from_indexed_events", async () => {
      const endpoint: WebhookEndpointRecord = {
        id: "we_1",
        url: "https://example.com/webhook",
        secret: "whsec_test",
        events: ["invoice.paid"],
      };

      const unindexedEvent = {
        id: "evt_unindexed",
        type: "invoice.paid",
        created: 1793577600,
        data: { token_id: "1" },
        indexed: false,
      } as unknown as IndexedEvent;

      // Unindexed events are rejected
      await expect(
        deliverWebhook(endpoint, unindexedEvent, {
          fetchImpl: async () => new Response("OK", { status: 200 }),
        }),
      ).rejects.toThrow(WebhookNotIndexed);
    });

    it("api_key_hashed_and_scoped", async () => {
      const auth = new AuthStore();
      const { app } = makeApp({ auth });

      // 1. Storage hashing: secret is never stored in plaintext, only sha256 hash
      const { secret: sk, record: skRecord } = auth.createApiKey(
        "alice.near",
        "my_secret_key",
        "secret",
        ["admin"],
      );
      const { secret: pk, record: pkRecord } = auth.createApiKey(
        "alice.near",
        "my_publishable_key",
        "publishable",
        ["pay"],
      );

      expect(sk).toMatch(/^or_sk_live_/);
      expect(pk).toMatch(/^or_pk_live_/);

      expect(skRecord.hash).toBe(hashApiKey(sk));
      expect(pkRecord.hash).toBe(hashApiKey(pk));

      // Key listing only contains hashes, never the secret
      const listed = auth.listApiKeys();
      for (const key of listed) {
        expect((key as unknown as Record<string, unknown>).secret).toBeUndefined();
        expect(key.hash).toBeDefined();
        expect(key.hash.length).toBe(64);
      }

      // 2. Scoping: publishable keys cannot issue invoices (POST /v1/invoices)
      const invoiceReq: ApiRequest = {
        method: "POST",
        path: "/v1/invoices",
        query: new URLSearchParams(),
        headers: {
          authorization: `Bearer ${pk}`,
        },
        body: {
          invoice_number: "INV-PUB-01",
          issuer_legal_name: "Alice",
          debtor_legal_name: "Bob",
          debtor_key: "ed25519:6E8sCci9badyRkXb3JoRpAxnri39Sa3q48sYw19A6U1s",
          amount_usd: "10.00",
          due_date: "2026-12-31",
        },
      };

      const forbiddenRes = await app.handle(invoiceReq);
      expect(forbiddenRes.status).toBe(403);
      expect((forbiddenRes.body as { error: { code: string } }).error.code).toBe("forbidden");

      // Secret key succeeds on invoice creation
      const successRes = await app.handle({
        ...invoiceReq,
        headers: { authorization: `Bearer ${sk}` },
      });
      expect(successRes.status).toBe(201);
    });
  });

  describe("Routes invariants", () => {
    it("route_allowlisted", async () => {
      const routes = loadRoutes();
      const { app, auth } = makeApp({ routes });
      const { secret: pk } = auth.createApiKey("alice.near", "pk", "publishable");

      // R1 through R13 are all allowlisted
      for (let i = 1; i <= 13; i++) {
        const routeId = `R${i}`;
        const found = routes.routes.find((r) => r.id === routeId);
        expect(found).toBeDefined();
      }

      // Non-allowlisted route rejected with 400
      const res = await app.handle({
        method: "POST",
        path: "/v1/pay/sessions",
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${pk}` },
        body: {
          token_id: "1",
          route_id: "R99_NOT_EXIST",
          refund_to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        },
      });
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe("unknown_route");
    });

    it("route_destination_is_settlement_asset", () => {
      const routes = loadRoutes();
      expect(routes.settlementAssets.length).toBeGreaterThan(0);

      // Every route in routes.json must point to one of the configured settlement assets
      for (const route of routes.routes) {
        expect(
          routes.settlementAssets,
          `Route ${route.id} destinationAssetId ${route.destinationAssetId} must be in settlementAssets`,
        ).toContain(route.destinationAssetId);
      }
    });

    it("volatile_asset_uses_exact_output", async () => {
      const routes = loadRoutes();
      let capturedRequest: QuoteProviderRequest | null = null;
      const quoteProvider: QuoteProvider = {
        quote: async (req) => {
          capturedRequest = req;
          return {
            quoteId: "q_test",
            depositAddress: "0xdeposit12345678901234567890123456789012",
            deadline: req.deadline,
            amountIn: "1000000000000000",
            amountOut: req.amount,
            spreadBps: 20,
          };
        },
      };

      const quoteService = new QuoteService({
        routes,
        claim: async (tokenId) => ({
          tokenId,
          claimAccount: "c1.openrail.near",
          termsHash: "0xhash",
          outstanding: "50000000",
          amountDue: "50000000",
          kindRules: {
            ack_required_for_sale: true,
            sellable: true,
            quote_deadline: 3600,
            debtor_optional: false,
          },
        }),
        provider: quoteProvider,
        logger: { logQuote: async () => ({ txHash: "tx_1" }) },
      });

      // Volatile routes: R9-R12 (ETH) and R13 (SOL) must use EXACT_OUTPUT with 30 bps slippage
      const volatileRoutes = ["R9", "R10", "R11", "R12", "R13"];
      for (const routeId of volatileRoutes) {
        const route = routes.routes.find((r) => r.id === routeId)!;
        expect(route.swapType).toBe("EXACT_OUTPUT");

        await quoteService.createSession({
          tokenId: "1",
          routeId,
          refundTo: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        });

        expect(capturedRequest).not.toBeNull();
        expect(capturedRequest!.swapType).toBe("EXACT_OUTPUT");
        expect(capturedRequest!.slippageTolerance).toBe(30);
      }

      // Stable routes: R1-R8 (USDC) must use FLEX_INPUT with 0 bps
      const stableRoutes = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"];
      for (const routeId of stableRoutes) {
        const route = routes.routes.find((r) => r.id === routeId)!;
        expect(route.swapType).toBe("FLEX_INPUT");

        await quoteService.createSession({
          tokenId: "1",
          routeId,
          refundTo: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        });

        expect(capturedRequest).not.toBeNull();
        expect(capturedRequest!.swapType).toBe("FLEX_INPUT");
        expect(capturedRequest!.slippageTolerance).toBe(0);
      }
    });

    it("exact_output_equals_outstanding", async () => {
      const routes = loadRoutes();
      let capturedAmount = "";
      const quoteProvider: QuoteProvider = {
        quote: async (req) => {
          capturedAmount = req.amount;
          return {
            quoteId: "q_test",
            depositAddress: "0xdeposit12345678901234567890123456789012",
            deadline: req.deadline,
            amountIn: "1000000000000000",
            amountOut: req.amount,
          };
        },
      };

      const testAmounts = ["1", "50000000", "123456789", "999999999999"];

      for (const outstanding of testAmounts) {
        const quoteService = new QuoteService({
          routes,
          claim: async (tokenId) => ({
            tokenId,
            claimAccount: "c1.openrail.near",
            termsHash: "0xhash",
            outstanding,
            amountDue: outstanding,
            kindRules: {
              ack_required_for_sale: true,
              sellable: true,
              quote_deadline: 3600,
              debtor_optional: false,
            },
          }),
          provider: quoteProvider,
          logger: { logQuote: async () => ({ txHash: "tx_1" }) },
        });

        await quoteService.createSession({
          tokenId: "1",
          routeId: "R10", // Base ETH: EXACT_OUTPUT
          refundTo: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        });

        // The requested output amount strictly equals claim outstanding in base units
        expect(capturedAmount).toBe(outstanding);
      }
    });

    it("refund_to_matches_origin_chain", async () => {
      // 1. EVM chains: valid 20-byte 0x-prefixed hex required
      expect(() =>
        validateRefundAddress("base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
      ).not.toThrow();
      expect(() =>
        validateRefundAddress("arbitrum", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
      ).not.toThrow();
      // Bad length or bad characters
      expect(() => validateRefundAddress("base", "0xnothex")).toThrow(AddressError);
      expect(() => validateRefundAddress("base", "0x1234")).toThrow(AddressError);
      // Mixed-case with invalid EIP-55 checksum fails
      expect(() =>
        validateRefundAddress("base", "0x833589fCd6edb6e08f4c7c32d4f71b54bda02913"),
      ).toThrow(AddressError);

      // 2. Solana: 32-byte base58 required
      expect(() =>
        validateRefundAddress("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      ).not.toThrow();
      expect(() =>
        validateRefundAddress("solana", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
      ).toThrow(AddressError);
      expect(() => validateRefundAddress("solana", "short")).toThrow(AddressError);

      // 3. NEAR: valid near account ID syntax
      expect(() => validateRefundAddress("near", "alice.near")).not.toThrow();
      expect(() => validateRefundAddress("near", "sub-account.alice.near")).not.toThrow();
      expect(() => validateRefundAddress("near", "UPPERCASE.near")).toThrow(AddressError);
      expect(() => validateRefundAddress("near", "bad/char")).toThrow(AddressError);

      // 4. API layer integration check
      const { app, auth } = makeApp();
      const { secret: pk } = auth.createApiKey("alice.near", "pk", "publishable");

      // Sending Solana address for Base route (R1) returns 400 invalid_refund_address
      const res = await app.handle({
        method: "POST",
        path: "/v1/pay/sessions",
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${pk}` },
        body: {
          token_id: "1",
          route_id: "R1", // Base EVM
          refund_to: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // Solana address
        },
      });
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe("invalid_refund_address");
    });

    it("volatile_quote_never_reused", () => {
      const now = new Date("2026-11-02T12:00:00Z");

      // Quote with future deadline is valid
      const futureDeadline = "2026-11-02T13:00:00Z";
      expect(isQuoteExpired(futureDeadline, now)).toBe(false);

      // Quote exactly at deadline or in past is expired and cannot be reused
      const exactDeadline = "2026-11-02T12:00:00Z";
      expect(isQuoteExpired(exactDeadline, now)).toBe(true);

      const pastDeadline = "2026-11-02T11:59:59Z";
      expect(isQuoteExpired(pastDeadline, now)).toBe(true);
    });

    it("quote_note_before_address_shown", async () => {
      const routes = loadRoutes();
      const executionOrder: string[] = [];

      const quoteProvider: QuoteProvider = {
        quote: async (req) => {
          executionOrder.push("provider.quote");
          return {
            quoteId: "q_test",
            depositAddress: "0xdeposit_secret_address",
            deadline: req.deadline,
            amountIn: "1000",
            amountOut: req.amount,
          };
        },
      };

      // 1. Success case: verify logQuote happens before session returns deposit address
      const quoteService = new QuoteService({
        routes,
        claim: async (tokenId) => ({
          tokenId,
          claimAccount: "c1.openrail.near",
          termsHash: "0xhash",
          outstanding: "50000000",
          amountDue: "50000000",
          kindRules: {
            ack_required_for_sale: true,
            sellable: true,
            quote_deadline: 3600,
            debtor_optional: false,
          },
        }),
        provider: quoteProvider,
        logger: {
          logQuote: async () => {
            executionOrder.push("logger.logQuote");
            return { txHash: "tx_logged" };
          },
        },
      });

      const session = await quoteService.createSession({
        tokenId: "1",
        routeId: "R1",
        refundTo: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      });

      expect(executionOrder).toEqual(["provider.quote", "logger.logQuote"]);
      expect(session.deposit_address).toBe("0xdeposit_secret_address");

      // 2. Failure case: if logQuote fails/reverts on-chain, deposit address must NOT be returned
      const failingQuoteService = new QuoteService({
        routes,
        claim: async (tokenId) => ({
          tokenId,
          claimAccount: "c1.openrail.near",
          termsHash: "0xhash",
          outstanding: "50000000",
          amountDue: "50000000",
          kindRules: {
            ack_required_for_sale: true,
            sellable: true,
            quote_deadline: 3600,
            debtor_optional: false,
          },
        }),
        provider: quoteProvider,
        logger: {
          logQuote: async () => {
            throw new Error("CONTRACT_REVERT: log_quote transaction failed");
          },
        },
      });

      await expect(
        failingQuoteService.createSession({
          tokenId: "1",
          routeId: "R1",
          refundTo: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        }),
      ).rejects.toThrow("CONTRACT_REVERT: log_quote transaction failed");
    });
  });
});
