import { describe, expect, it } from "vitest";
import { walletHint } from "./hints";

const H = {
  scanTwice: "TWICE.",
  hotNoExtension: "HOTAPP.",
  popupBlocked: "POPUP.",
  walletConnectNear: "WCNEAR.",
};

describe("walletHint", () => {
  it("HOT and NEAR Mobile ask for two scans: one to connect, one to sign", () => {
    expect(walletHint("near-mobile-wallet", false, H)).toBe("TWICE.");
    expect(walletHint("hot-wallet", true, H)).toBe("TWICE.");
  });
  it("HOT without its extension on the page also says to use the app", () => {
    expect(walletHint("hot-wallet", false, H)).toBe("TWICE. HOTAPP.");
  });
  it("Intear asks to allow pop-ups, because Chrome blocks its second window", () => {
    expect(walletHint("intear-wallet", false, H)).toBe("POPUP.");
  });
  it("WalletConnect says which wallets can use it", () => {
    expect(walletHint("wallet-connect", false, H)).toBe("WCNEAR.");
  });
  it("other wallets need no advice", () => {
    expect(walletHint("meteor-wallet", false, H)).toBeNull();
    expect(walletHint("nightly", false, H)).toBeNull();
  });
});
