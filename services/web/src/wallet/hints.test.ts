import { describe, expect, it } from "vitest";
import { walletHint } from "./hints";

const H = {
  scanTwice: "TWICE.",
  hotNoExtension: "HOTAPP.",
  popupBlocked: "POPUP.",
  walletConnectNear: "WCNEAR.",
};

describe("walletHint", () => {
  it("HOT asks for two scans: one to connect, one to sign", () => {
    expect(walletHint("hot-wallet", true, H)).toBe("TWICE.");
  });
  it("HOT without its extension on the page also says to use the app", () => {
    expect(walletHint("hot-wallet", false, H)).toBe("TWICE. HOTAPP.");
  });
  it("Intear asks to allow pop-ups, because Chrome blocks its second window", () => {
    expect(walletHint("intear-wallet", false, H)).toBe("POPUP.");
  });
  it("removed wallets get no advice", () => {
    expect(walletHint("near-mobile-wallet", false, H)).toBeNull();
    expect(walletHint("wallet-connect", false, H)).toBeNull();
  });
  it("other wallets need no advice", () => {
    expect(walletHint("meteor-wallet", false, H)).toBeNull();
    expect(walletHint("nightly", false, H)).toBeNull();
  });
});
