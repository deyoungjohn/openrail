import { describe, expect, it } from "vitest";
import { AddressError, validateRefundAddress } from "./addresses.js";

describe("refund address validation", () => {
  it("accepts an EVM address and rejects a bad one", () => {
    expect(() => validateRefundAddress("base", "0x" + "e".repeat(40))).not.toThrow();
    expect(() => validateRefundAddress("base", "0x123")).toThrow(AddressError);
    expect(() => validateRefundAddress("ethereum", "")).toThrow("invalid_refund_address");
  });

  it("rejects a mixed-case EVM address with a bad checksum", () => {
    expect(() =>
      validateRefundAddress("base", "0x52908400098527886E0F7030069857D2E4169EE8"),
    ).toThrow("EIP-55");
  });

  it("accepts a 32-byte Solana address and rejects a short one", () => {
    expect(() => validateRefundAddress("solana", "11111111111111111111111111111111")).not.toThrow();
    expect(() => validateRefundAddress("solana", "abc")).toThrow(AddressError);
  });

  it("accepts a NEAR account and rejects an invalid one", () => {
    expect(() => validateRefundAddress("near", "debtor.openrail.near")).not.toThrow();
    expect(() => validateRefundAddress("near", "Bad Account")).toThrow(AddressError);
  });

  it("rejects an unknown chain", () => {
    expect(() => validateRefundAddress("unknown", "0x" + "e".repeat(40))).toThrow(
      "unsupported_chain",
    );
  });
});
