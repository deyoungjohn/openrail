import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OneClickClient,
  OneClickRequestError,
  createOneClickClientFromEnv,
  type OneClickFetchLike,
  type OneClickQuoteResponse,
} from "./index.js";

const FIXTURES = new URL("../../../../fixtures/oneclick/", import.meta.url);
const API_KEY = "test-key-" + "not-a-real-secret";

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

function quoteFixture(): OneClickQuoteResponse {
  return JSON.parse(fixture("quote-response.json")) as OneClickQuoteResponse;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  delete process.env.ONECLICK_API_URL;
  delete process.env.ONECLICK_JWT;
  vi.restoreAllMocks();
});

describe("oneclick auth", () => {
  it("sends Authorization: Bearer first and records that it worked", async () => {
    const fetchImpl = vi.fn<OneClickFetchLike>(async () => jsonResponse(quoteFixture(), 201));
    const client = new OneClickClient({
      baseUrl: "https://1click.test",
      apiKey: API_KEY,
      fetchImpl,
    });

    await client.quote({ amount: "1000000" });

    expect(client.authMode).toBe("bearer");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(headersOf(init).authorization).toBe(`Bearer ${API_KEY}`);
    expect(headersOf(init)["x-api-key"]).toBeUndefined();
  });

  it("falls back to X-API-Key only after a 401 and records the mode that worked", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse(quoteFixture(), 201));
    const client = new OneClickClient({
      baseUrl: "https://1click.test",
      apiKey: API_KEY,
      fetchImpl,
    });

    const quote = await client.quote({ amount: "1000000" });

    expect(quote.quote.amountOut).toBeDefined();
    expect(client.authMode).toBe("x-api-key");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(headersOf(fetchImpl.mock.calls[0]?.[1] as RequestInit).authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(headersOf(fetchImpl.mock.calls[1]?.[1] as RequestInit)["x-api-key"]).toBe(API_KEY);
  });

  it("never logs the key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn<OneClickFetchLike>(async () => jsonResponse(quoteFixture(), 201));
    const client = new OneClickClient({
      baseUrl: "https://1click.test",
      apiKey: API_KEY,
      fetchImpl,
    });

    await client.quote({ amount: "1000000" });

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("raises a typed error that does not contain the key", async () => {
    const fetchImpl = vi.fn<OneClickFetchLike>(async () =>
      jsonResponse(fixture("deposit-submit-error.json"), 500),
    );
    const client = new OneClickClient({
      baseUrl: "https://1click.test",
      apiKey: API_KEY,
      fetchImpl,
    });

    const error = await client
      .submitDeposit({ txHash: "0xdead", depositAddress: "0xbeef" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OneClickRequestError);
    expect((error as Error).message).toContain("500");
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it("requires the base URL and key from env", () => {
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    expect(() => createOneClickClientFromEnv()).toThrow("EXIT:1");
  });
});

describe("oneclick endpoints", () => {
  it("posts a quote request and returns the recorded response", async () => {
    const fetchImpl = vi.fn<OneClickFetchLike>(async () => jsonResponse(quoteFixture(), 201));
    const client = new OneClickClient({
      baseUrl: "https://1click.test/",
      apiKey: API_KEY,
      fetchImpl,
    });

    const quote = await client.quote({ amount: "1000000", swapType: "FLEX_INPUT" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://1click.test/v0/quote");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      amount: "1000000",
      swapType: "FLEX_INPUT",
    });
    expect(quote.quote.depositAddress).toBeDefined();
  });

  it("reads status fields from swapDetails", async () => {
    const fetchImpl = vi.fn<OneClickFetchLike>(async () =>
      jsonResponse(fixture("status-response.json")),
    );
    const client = new OneClickClient({
      baseUrl: "https://1click.test",
      apiKey: API_KEY,
      fetchImpl,
    });

    const status = await client.status("0xdeposit");

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://1click.test/v0/status?depositAddress=0xdeposit",
    );
    expect(status.status).toBe("SUCCESS");
    expect(status.swapDetails.amountOut).toBe("10000000");
    expect(status.swapDetails.nearTxHashes).toHaveLength(2);
  });

  it("submits a deposit transaction hash", async () => {
    const fetchImpl = vi.fn<OneClickFetchLike>(async () => jsonResponse({ status: "OK" }, 200));
    const client = new OneClickClient({
      baseUrl: "https://1click.test",
      apiKey: API_KEY,
      fetchImpl,
    });

    const result = await client.submitDeposit({
      txHash: "0xdead",
      depositAddress: "0xdeposit",
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://1click.test/v0/deposit/submit");
    expect(result).toEqual({ status: "OK" });
  });
});
