/**
 * One line of advice shown under the Sign in button while a wallet is open, for the wallets that
 * surprise people. `hasHotExtension`: the page can see the HOT browser extension (it does not offer NEAR
 * sign-in to websites, so HOT opens its app).
 */
export function walletHint(
  walletId: string,
  hasHotExtension: boolean,
  hints: {
    scanTwice: string;
    hotNoExtension: string;
    popupBlocked: string;
    walletConnectNear: string;
  },
): string | null {
  switch (walletId) {
    case "hot-wallet":
      return hasHotExtension ? hints.scanTwice : `${hints.scanTwice} ${hints.hotNoExtension}`;
    case "near-mobile-wallet":
      return hints.scanTwice;
    case "intear-wallet":
      return hints.popupBlocked;
    case "wallet-connect":
      return hints.walletConnectNear;
    default:
      return null;
  }
}
