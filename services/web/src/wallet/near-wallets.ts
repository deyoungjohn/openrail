import type { WalletModuleFactory } from "@near-wallet-selector/core";
import { setupBitgetWallet } from "@near-wallet-selector/bitget-wallet";
import { setupCoin98Wallet } from "@near-wallet-selector/coin98-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupNearMobileWallet } from "@near-wallet-selector/near-mobile-wallet";
import { setupNightly } from "@near-wallet-selector/nightly";
import { setupWalletConnect } from "@near-wallet-selector/wallet-connect";

// The wallets we offer: active NEAR wallets people use (Meteor, HOT, Here, Nightly, Intear, NEAR
// Mobile, Coin98) plus WalletConnect for Trust and others. OKX is out for now: it refuses to connect
// below 0.1 NEAR and its burner accounts are not on chain. Order is only the default; the
// picker puts wallets that can sign you in first, using the selector's own capability check
// (see probe.ts).
//
// Trust Wallet connects through WalletConnect, which needs a project id from
// https://cloud.reown.com in NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID. Without one WalletConnect is
// not offered; the other wallets still work.
export function nearWalletModules(origin: string): WalletModuleFactory[] {
  const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  return [
    setupMeteorWallet(),
    setupHotWallet(),
    setupHereWallet(),
    setupNightly(),
    setupIntearWallet(),
    setupNearMobileWallet(),
    setupBitgetWallet(),
    setupCoin98Wallet(),
    ...(projectId
      ? [
          setupWalletConnect({
            projectId,
            chainId: "near:mainnet",
            metadata: {
              name: "Openrail",
              description: "Get paid in USDC from any chain",
              url: origin,
              icons: [`${origin}/icon.svg`],
            },
          }),
        ]
      : []),
  ];
}
