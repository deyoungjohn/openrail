import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// The selector decides signMessage support by whether a wallet module's behaviour defines the
// method (decorateWallet in @near-wallet-selector/core refuses the call otherwise). This reads each
// installed module and pins the result, so a version bump that changes a wallet's capability fails
// here and the PR table must be redone. Runtime probing in a browser is in e2e/wallets.spec.ts.
const require = createRequire(import.meta.url);
const definesSignMessage = (pkg: string): boolean =>
  /^[ \t]+signMessage\s*\(/m.test(readFileSync(require.resolve(pkg), "utf8"));

const EXPECTED: Record<string, boolean> = {
  "@near-wallet-selector/meteor-wallet": true,
  "@near-wallet-selector/hot-wallet": true,
  "@near-wallet-selector/here-wallet": true,
  "@near-wallet-selector/nightly": true,
  "@near-wallet-selector/intear-wallet": true,
  "@near-wallet-selector/near-mobile-wallet": true,
  "@near-wallet-selector/okx-wallet": true,
  "@near-wallet-selector/wallet-connect": true,
  // Bitget's module has no signMessage: the selector refuses it, so it cannot sign you in.
  "@near-wallet-selector/bitget-wallet": false,
};

describe("which wallet modules define signMessage (selector 10.1.4)", () => {
  for (const [pkg, expected] of Object.entries(EXPECTED))
    it(`${pkg}: ${expected ? "yes" : "no"}`, () => {
      expect(definesSignMessage(pkg)).toBe(expected);
    });

  it("MyNearWallet is not installed", () => {
    expect(() => require.resolve("@near-wallet-selector/my-near-wallet")).toThrow();
  });
});
