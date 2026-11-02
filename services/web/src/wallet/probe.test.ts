import { describe, expect, it } from "vitest";
import { classifyProbe } from "./probe";

// The selector core's own check for signMessage runs before it validates the parameters
// (decorateWallet in @near-wallet-selector/core): an unsupported wallet throws "...is not
// supported by <name>", a supporting one reaches the parameter validation and throws "Invalid ...".
describe("classifyProbe", () => {
  it("a wallet the selector says does not support signMessage", () => {
    expect(
      classifyProbe(new Error("The signMessage method is not supported by Meteor Wallet")),
    ).toBe(false);
  });
  it("a wallet that reaches parameter validation supports it", () => {
    expect(classifyProbe(new Error("Invalid message. It must be a non-empty string."))).toBe(true);
    expect(
      classifyProbe(new Error("Invalid nonce. It must be a Buffer with a length of 32 bytes.")),
    ).toBe(true);
  });
  it("anything else is unknown, never a guess", () => {
    expect(classifyProbe(new Error("Wallet not installed"))).toBeNull();
    expect(classifyProbe("boom")).toBeNull();
    expect(classifyProbe(undefined)).toBeNull();
  });
});
