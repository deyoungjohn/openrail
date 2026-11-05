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

import { staticSignsMessage, withTimeout } from "./probe";

describe("static wallet capabilities and the probe timeout", () => {
  it("knows the wallets we offer, and Bitget cannot sign you in", () => {
    for (const id of ["meteor-wallet", "hot-wallet", "here-wallet", "nightly", "intear-wallet"])
      expect(staticSignsMessage(id)).toBe(true);
    expect(staticSignsMessage("bitget-wallet")).toBe(false);
    expect(staticSignsMessage("unknown-wallet")).toBeNull();
  });
  it("gives up on a module that never answers", async () => {
    await expect(withTimeout(new Promise<void>(() => {}), 20)).rejects.toThrow("PROBE_TIMEOUT");
  });
  it("passes a fast answer through", async () => {
    await expect(withTimeout(Promise.resolve(3), 1000)).resolves.toBe(3);
  });
});
