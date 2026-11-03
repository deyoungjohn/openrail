import { describe, expect, it } from "vitest";
import { accountDisplay, isNearAccountId } from "./near-account";

const IMPLICIT = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";

describe("isNearAccountId: named and implicit accounts (multichain wallets use implicit ones)", () => {
  it("accepts named accounts", () => {
    for (const a of [
      "alice.near",
      "acme.openrail.near",
      "c-1.openrail.near",
      "a1",
      "x_y-z.testnet",
    ])
      expect(isNearAccountId(a)).toBe(true);
  });
  it("accepts an implicit account: exactly 64 lowercase hex characters", () => {
    expect(isNearAccountId(IMPLICIT)).toBe(true);
  });
  it("refuses a 63 or 65 character hex string that is not a valid named account shape", () => {
    expect(isNearAccountId(IMPLICIT + "0")).toBe(false);
    expect(isNearAccountId(IMPLICIT.toUpperCase())).toBe(false);
  });
  it("refuses empty, spaced, uppercase and dotted-edge input", () => {
    for (const a of ["", " ", "Not An Account", "Alice.near", ".near", "alice.", "a..b", "-a.near"])
      expect(isNearAccountId(a)).toBe(false);
  });
});

describe("accountDisplay: never hide a mistake", () => {
  it("shows a named account in full", () => {
    expect(accountDisplay("acme.openrail.near")).toEqual({
      text: "acme.openrail.near",
      truncated: false,
    });
  });
  it("middle-truncates only an implicit account, keeping both ends and the full value for the tooltip", () => {
    const d = accountDisplay(IMPLICIT);
    expect(d.truncated).toBe(true);
    expect(d.text).toBe("98793cd91a…f0dbd6de");
    expect(d.text.startsWith(IMPLICIT.slice(0, 10))).toBe(true);
    expect(d.text.endsWith(IMPLICIT.slice(-8))).toBe(true);
  });
  it("lets the caller ask for the full value", () => {
    expect(accountDisplay(IMPLICIT, { full: true })).toEqual({ text: IMPLICIT, truncated: false });
  });
});
