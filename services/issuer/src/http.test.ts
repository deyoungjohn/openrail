import { createLogger } from "@openrail/shared";
import { describe, expect, it, vi } from "vitest";
import { IssuerError } from "./errors.js";
import { createIssuerApp, isAuthorized } from "./http.js";
import type { IssuerService } from "./service.js";

const KEY = "issuer-service-test-key";
const logger = createLogger("issuer-http-test", () => {});

function fakeService() {
  return {
    prepareIssue: vi.fn(async () => ({
      account: "openrail.near",
      amount: "20000000000000000000000",
      storageCredit: "0",
    })),
    issueFor: vi.fn(async () => ({
      txHash: "tx-issue",
      tokenId: "c-5",
      claimAccount: "c-5.openrail.near",
    })),
    logQuote: vi.fn(async () => ({ txHash: "tx-quote" })),
    acknowledgeEvm: vi.fn(async () => ({ txHash: "tx-ack", ack: null })),
  } as unknown as IssuerService;
}

function app(service = fakeService(), health?: () => Promise<Record<string, unknown>>) {
  return { app: createIssuerApp({ service, serviceKey: KEY, logger, health }), service };
}

const ISSUE_BODY = JSON.stringify({
  business: "acme.near",
  kind: 0,
  debtor: { Near: "client.near" },
  termsHash: "0x" + "11".repeat(32),
  amountDue: "1000000",
  dueDate: 1_800_000_000,
});

describe("issuer HTTP claim labels", () => {
  it("passes claimLabel through to the service", async () => {
    const { app: issuer, service } = app();
    const response = await issuer.handle(
      "POST",
      "/issue",
      { authorization: `Bearer ${KEY}` },
      JSON.stringify({
        ...JSON.parse(ISSUE_BODY),
        claimLabel: "belmonte-9f3c2a7d41b8",
      }),
    );
    expect(response.status).toBe(200);
    expect(service.issueFor).toHaveBeenCalledWith(
      expect.objectContaining({ claimLabel: "belmonte-9f3c2a7d41b8" }),
    );
  });
});

describe("issuer HTTP auth", () => {
  it("rejects a missing, wrong or non-bearer key", async () => {
    const { app: issuer } = app();
    for (const headers of [{}, { authorization: "Bearer wrong" }, { "x-issuer-key": KEY }]) {
      const response = await issuer.handle(
        "POST",
        "/issue/prepare",
        headers,
        JSON.stringify({ account_id: "acme.near" }),
      );
      expect(response.status).toBe(401);
    }
  });

  it("accepts only Authorization: Bearer", async () => {
    const { app: issuer, service } = app();
    const response = await issuer.handle(
      "POST",
      "/issue/prepare",
      { authorization: `Bearer ${KEY}` },
      JSON.stringify({ account_id: "acme.near" }),
    );
    expect(response.status).toBe(200);
    expect(service.prepareIssue).toHaveBeenCalledWith("acme.near");
  });

  it("compares keys without short-circuiting on length", () => {
    expect(isAuthorized({ authorization: `Bearer ${KEY}` }, KEY)).toBe(true);
    expect(isAuthorized({ authorization: `Bearer ${KEY}x` }, KEY)).toBe(false);
    expect(isAuthorized({}, KEY)).toBe(false);
  });
});

describe("issuer HTTP routes", () => {
  it("prepares an issue with the storage credit response", async () => {
    const { app: issuer, service } = app();
    const response = await issuer.handle(
      "POST",
      "/issue/prepare",
      { authorization: `Bearer ${KEY}` },
      JSON.stringify({ account_id: "acme.near" }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      account: "openrail.near",
      amount: "20000000000000000000000",
      storageCredit: "0",
    });
    expect(service.prepareIssue).toHaveBeenCalledWith("acme.near");
  });

  it("issues with the port's camelCase fields", async () => {
    const { app: issuer, service } = app();
    const response = await issuer.handle(
      "POST",
      "/issue",
      { authorization: `Bearer ${KEY}` },
      ISSUE_BODY,
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      txHash: "tx-issue",
      tokenId: "c-5",
      claimAccount: "c-5.openrail.near",
    });
    expect(service.issueFor).toHaveBeenCalledWith({
      business: "acme.near",
      kind: 0,
      debtor: { Near: "client.near" },
      termsHash: "0x" + "11".repeat(32),
      amountDue: "1000000",
      dueDate: 1_800_000_000,
    });
  });

  it("logs a quote", async () => {
    const { app: issuer, service } = app();
    const response = await issuer.handle(
      "POST",
      "/log_quote",
      { authorization: `Bearer ${KEY}` },
      JSON.stringify({
        tokenId: "c-5",
        quoteId: "q-1",
        depositAddress: "deposit",
        deadlineRequested: 1_800_000_000,
        refundTo: "0x" + "22".repeat(20),
        routeId: "base-usdc",
      }),
    );
    expect(response.status).toBe(200);
    expect(service.logQuote).toHaveBeenCalledWith({
      tokenId: "c-5",
      quoteId: "q-1",
      depositAddress: "deposit",
      deadlineRequested: 1_800_000_000,
      refundTo: "0x" + "22".repeat(20),
      routeId: "base-usdc",
    });
  });

  it("acknowledges an EVM signature", async () => {
    const { app: issuer, service } = app();
    const response = await issuer.handle(
      "POST",
      "/ack/evm",
      { authorization: `Bearer ${KEY}` },
      JSON.stringify({ tokenId: "c-5", chainId: 8453, signature: "0x" + "33".repeat(65) }),
    );
    expect(response.status).toBe(200);
    expect(service.acknowledgeEvm).toHaveBeenCalledWith({
      tokenId: "c-5",
      chainId: 8453,
      signature: "0x" + "33".repeat(65),
    });
  });

  it("validates request fields", async () => {
    const { app: issuer } = app();
    const bad = [
      ["/issue/prepare", JSON.stringify({})],
      ["/issue", JSON.stringify({ ...JSON.parse(ISSUE_BODY), termsHash: "nope" })],
      ["/issue", JSON.stringify({ ...JSON.parse(ISSUE_BODY), kind: "0" })],
      ["/log_quote", JSON.stringify({ tokenId: "c-5" })],
      ["/ack/evm", JSON.stringify({ tokenId: "c-5", chainId: "8453", signature: "0x00" })],
    ] as const;
    for (const [path, body] of bad) {
      const response = await issuer.handle("POST", path, { authorization: `Bearer ${KEY}` }, body);
      expect(response.status, path).toBe(400);
    }
  });

  it("returns 404 for unknown paths and 405 for the wrong method", async () => {
    const { app: issuer } = app();
    const missing = await issuer.handle("POST", "/nope", { authorization: `Bearer ${KEY}` }, "{}");
    expect(missing.status).toBe(404);
    const wrong = await issuer.handle(
      "GET",
      "/issue/prepare",
      { authorization: `Bearer ${KEY}` },
      "",
    );
    expect(wrong.status).toBe(405);
  });

  it("serves /health without auth", async () => {
    const { app: issuer } = app(fakeService(), async () => ({
      issuer_key: { allowance_near: 1.5 },
      relay_key: { allowance_near: 0.5 },
    }));
    const response = await issuer.handle("GET", "/health", {}, "");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      issuer_key: { allowance_near: 1.5 },
      relay_key: { allowance_near: 0.5 },
    });
  });

  it("maps service errors", async () => {
    const service = fakeService();
    service.prepareIssue = vi.fn(async () => {
      throw new IssuerError(409, "ISSUE_IN_FLIGHT");
    });
    const { app: issuer } = app(service);
    const conflict = await issuer.handle(
      "POST",
      "/issue/prepare",
      { authorization: `Bearer ${KEY}` },
      JSON.stringify({ account_id: "acme.near" }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      error: { code: "ISSUE_IN_FLIGHT", message: "ISSUE_IN_FLIGHT" },
    });

    service.prepareIssue = vi.fn(async () => {
      throw new Error("boom");
    });
    const upstream = await issuer.handle(
      "POST",
      "/issue/prepare",
      { authorization: `Bearer ${KEY}` },
      JSON.stringify({ account_id: "acme.near" }),
    );
    expect(upstream.status).toBe(502);
    expect(upstream.body).toEqual({ error: { code: "upstream_error" } });
  });
});
