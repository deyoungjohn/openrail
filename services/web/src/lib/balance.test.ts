import { describe, expect, it } from "vitest";
import { usdcNetwork } from "./balance";

describe("usdcNetwork: which USDC a token id on intents.near is", () => {
  it("names the network of each USDC", () => {
    expect(usdcNetwork("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near")).toBe(
      "Base",
    );
    expect(
      usdcNetwork("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
    ).toBe("NEAR");
  });
  it("does not value anything else as USDC", () => {
    expect(usdcNetwork("nep141:eth.omft.near")).toBeNull();
    expect(
      usdcNetwork("nep141:base-0x0000000000000000000000000000000000000001.omft.near"),
    ).toBeNull();
  });
});
