import { afterEach, describe, expect, it } from "vitest";
import { nearRpcUrlsFromEnv } from "./index.js";

const NAMES = [
  "NEAR_RPC_URL",
  "NEAR_RPC_URL_FALLBACK",
  "NEAR_RPC_URL_FALLBACK_2",
  "NEAR_RPC_URL_FALLBACK_3",
];

describe("nearRpcUrlsFromEnv", () => {
  afterEach(() => {
    for (const name of NAMES) delete process.env[name];
  });

  it("lists the primary first, then every fallback in order, without duplicates", () => {
    process.env.NEAR_RPC_URL = "https://keyed.example/k, https://b.example";
    process.env.NEAR_RPC_URL_FALLBACK = "https://fast.example,https://b.example";
    process.env.NEAR_RPC_URL_FALLBACK_2 = "https://last.example";
    expect(nearRpcUrlsFromEnv()).toEqual([
      "https://keyed.example/k",
      "https://b.example",
      "https://fast.example",
      "https://last.example",
    ]);
  });

  it("works with the primary alone", () => {
    process.env.NEAR_RPC_URL = "https://only.example";
    expect(nearRpcUrlsFromEnv()).toEqual(["https://only.example"]);
  });

  it("reads the names without the second underscore too (FALLBACK1, FALLBACK2)", () => {
    // The human's env file used NEAR_RPC_URL_FALLBACK1/2 and the services read none of them (9 Nov).
    process.env.NEAR_RPC_URL = "https://keyed.example/k";
    process.env.NEAR_RPC_URL_FALLBACK1 = "https://fast.example";
    process.env.NEAR_RPC_URL_FALLBACK2 = "https://public.example";
    expect(nearRpcUrlsFromEnv()).toEqual([
      "https://keyed.example/k",
      "https://fast.example",
      "https://public.example",
    ]);
  });
});
