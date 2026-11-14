import type { WalletModuleFactory } from "@near-wallet-selector/core";
import { setupBitgetWallet } from "@near-wallet-selector/bitget-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupNightly } from "@near-wallet-selector/nightly";
import { setupOKXWallet } from "@near-wallet-selector/okx-wallet";

// The wallets we offer: Meteor, HOT, Here, Nightly, Intear, OKX and Bitget. NEAR Mobile and WalletConnect were removed
// (14 Nov): NEAR Mobile signed twice without connecting and its QR sheet came back over other wallets; WalletConnect
// opened Nightly and never returned. OKX signs in without adding a key, and its fresh implicit account (not onchain
// yet) is accepted with its own key. Order is only the default; the picker puts wallets that can sign you in first
// (see probe.ts).
export function nearWalletModules(): WalletModuleFactory[] {
  return [
    setupMeteorWallet(),
    setupHotWallet(),
    setupHereWallet(),
    setupNightly(),
    setupIntearWallet(),
    setupOKXWallet(),
    setupBitgetWallet(),
  ];
}
