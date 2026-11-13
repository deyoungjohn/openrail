import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OneClickClient,
  type OneClickFetchLike,
  type OneClickGenerateIntentResponse,
  type OneClickSubmitIntentResponse,
} from "./index.js";

const FIXTURES = new URL("../../../../fixtures/oneclick/", import.meta.url);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: OneClickFetchLike): OneClickClient {
  return new OneClickClient({ baseUrl: "https://1click.test", apiKey: "partner-key", fetchImpl });
}

describe("1Click documented response shapes", () => {
  it("quote keeps quote.depositAddress", async () => {
    const response = fixture("quote-response.json");
    const quote = await client(async () => jsonResponse(response, 201)).quote({ amount: "1" });
    expect(typeof quote.quote.depositAddress).toBe("string");
  });

  it("status keeps swapDetails and its status word", async () => {
    const status = await client(async () => jsonResponse(fixture("status-response.json"))).status(
      "0xdeposit",
    );
    expect(status.status).toBe("SUCCESS");
    expect(Array.isArray(status.swapDetails.nearTxHashes)).toBe(true);
  });

  it("tokens is an array of assetId/decimals/blockchain/symbol/price/priceUpdatedAt", async () => {
    const tokens = await client(async () => jsonResponse(fixture("tokens-response.json"))).tokens();
    expect(tokens[0]).toMatchObject({
      assetId: expect.any(String),
      decimals: expect.any(Number),
      blockchain: expect.any(String),
      symbol: expect.any(String),
      price: expect.any(String),
      priceUpdatedAt: expect.any(String),
    });
  });

  it("generate-intent keeps intent.standard and intent.payload.{message,nonce,recipient}", async () => {
    const response = fixture("generate-intent-response.json");
    const intent = await client(async () => jsonResponse(response, 201)).generateIntent({
      type: "swap_transfer",
      standard: "nep413",
      signerId: "merchant.near",
      depositAddress: "0xdeposit",
    });
    const typed = intent as OneClickGenerateIntentResponse;
    expect(typed.intent.standard).toBe("nep413");
    expect(typed.intent.payload).toMatchObject({
      message: expect.any(String),
      nonce: expect.any(String),
      recipient: expect.any(String),
    });
  });

  it("submit-intent keeps intentHash and correlationId", async () => {
    const response = fixture("submit-intent-response.json");
    const submitted = await client(async () => jsonResponse(response, 201)).submitIntent({
      type: "swap_transfer",
      signedData: { standard: "nep413" },
    });
    expect((submitted as OneClickSubmitIntentResponse).intentHash).toEqual(expect.any(String));
    expect(submitted.correlationId).toEqual(expect.any(String));
  });

  it("auth keeps accessToken/refreshToken/expiresIn/refreshExpiresIn", async () => {
    const auth = await client(async () => jsonResponse(fixture("auth-response.json"))).authenticate(
      { standard: "nep413" },
    );
    expect(auth).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: expect.any(Number),
      refreshExpiresIn: expect.any(Number),
    });
  });

  it("balances keeps balances[].{tokenId,available,source}", async () => {
    const balances = await client(async () =>
      jsonResponse(fixture("balances-response.json")),
    ).balances("user-token", ["nep141:usdc"]);
    expect(balances.balances[0]).toMatchObject({
      tokenId: expect.any(String),
      available: expect.any(String),
      source: expect.any(String),
    });
  });

  it("deposit submit returns the provider acknowledgement", async () => {
    const result = await client(async () => jsonResponse({ status: "OK" })).submitDeposit({
      txHash: "0xdead",
      depositAddress: "0xdeposit",
    });
    expect(result).toEqual({ status: "OK" });
  });
});
