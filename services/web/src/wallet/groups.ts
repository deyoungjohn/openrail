import type { NearWalletInfo } from "./near";

export type PickerPurpose = "signIn" | "connect";

export interface WalletGroups {
  /** Selectable now. For sign-in these are the wallets that can sign a message. */
  usable: NearWalletInfo[];
  /** The selector has not told us yet. */
  checking: NearWalletInfo[];
  /** Sign-in only: the selector says this wallet has no signMessage. */
  cannotSign: NearWalletInfo[];
  /** Cannot run on this device, for example an extension that is not installed. */
  unavailable: NearWalletInfo[];
}

/**
 * Never offered for sign-in. Bitget: its module has no signMessage (pinned in capabilities.test.ts). Here:
 * its app rejects our sign request ("Invalid schema", SIGN_ERROR) after a successful connect, tried on
 * three builds; it comes back when its app accepts the request.
 */
const NO_SIGN_IN: readonly string[] = ["bitget-wallet", "here-wallet"];

/** Sort wallets for the picker. Sign-in lists the wallets that can sign a message first. */
export function groupWallets(
  wallets: readonly NearWalletInfo[],
  purpose: PickerPurpose,
): WalletGroups {
  const g: WalletGroups = { usable: [], checking: [], cannotSign: [], unavailable: [] };
  for (const w of wallets) {
    if (purpose === "signIn" && NO_SIGN_IN.includes(w.id)) continue;
    if (!w.available) g.unavailable.push(w);
    else if (purpose === "connect") g.usable.push(w);
    else if (w.signsMessage === true) g.usable.push(w);
    else if (w.signsMessage === false) g.cannotSign.push(w);
    else g.checking.push(w);
  }
  return g;
}
