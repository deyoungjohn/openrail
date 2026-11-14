"use client";

import { copy } from "@/copy";
import { useEvm } from "@/wallet/evm";
import type { PayWallet } from "@/wallet/pay-wallet";
import { useNear } from "@/wallet/near";
import { AccountId } from "./ui/account-id";
import { AddressChip } from "./ui/address-chip";
import { Button } from "./ui/button";

export function NearWalletButton() {
  return <NearWalletView {...useNear()} />;
}

/** Presentational half, so the gallery can show every state without a live selector. */
export function NearWalletView({
  accountId,
  ready,
  error,
  signIn,
  signOut,
}: {
  accountId: string | null;
  ready: boolean;
  error: boolean;
  signIn: () => void;
  signOut: () => Promise<void> | void;
}) {
  if (accountId)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="caption">{copy.wallet.signedInAs}</span>
        <AccountId value={accountId} />
        <Button variant="secondary" size="sm" onClick={() => void signOut()}>
          {copy.wallet.signOut}
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col items-start gap-1">
      <Button size="sm" onClick={signIn} disabled={!ready && !error} loading={!ready && !error}>
        {copy.wallet.near}: {copy.wallet.signIn}
      </Button>
      {error ? <p className="text-danger text-[13px]">{copy.wallet.nearFailed}</p> : null}
    </div>
  );
}

export function EvmWalletButton() {
  return <EvmWalletView {...useEvm()} />;
}

export function EvmWalletView({
  address,
  available,
  error,
  connect,
  disconnect,
}: {
  address: string | null;
  available: boolean;
  error: boolean;
  connect: () => Promise<void> | void;
  disconnect: () => void;
}) {
  if (address)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <AddressChip value={address} chain="ethereum" />
        <Button variant="secondary" size="sm" onClick={disconnect}>
          {copy.wallet.disconnect}
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col items-start gap-1">
      <Button size="sm" onClick={() => void connect()} disabled={!available}>
        {copy.wallet.evm}: {copy.wallet.connect}
      </Button>
      {!available ? <p className="caption">{copy.wallet.noEvmWallet}</p> : null}
      {error ? <p className="text-danger text-[13px]">{copy.wallet.evmFailed}</p> : null}
    </div>
  );
}

/** The connect control of the pay page's wallet tab: the wallet of the chosen route's chain, and nothing else. */
export function WalletConnectView({ wallet, chosen }: { wallet: PayWallet; chosen: boolean }) {
  const t = copy.wallet;
  if (!chosen) return <p className="caption">{t.pickRouteFirst}</p>;
  if (wallet.kind === null || !wallet.available)
    return <p className="caption">{t.noWalletForRoute}</p>;
  if (wallet.address)
    return (
      <div className="flex flex-wrap items-center gap-2">
        {wallet.walletName ? <span className="caption">{wallet.walletName}</span> : null}
        <AddressChip
          value={wallet.address}
          chain={wallet.kind === "solana" ? "solana" : wallet.kind === "near" ? "near" : "ethereum"}
        />
        <Button variant="secondary" size="sm" onClick={wallet.disconnect}>
          {t.disconnect}
        </Button>
      </div>
    );
  if (wallet.choices.length > 1)
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="caption">{t.pickEvmWallet}</p>
        <div className="flex flex-wrap gap-2">
          {wallet.choices.map((w) => (
            <Button key={w.id} size="sm" variant="secondary" onClick={() => wallet.connect(w.id)}>
              {w.icon ? (
                <img src={w.icon} alt="" width={18} height={18} className="size-[18px] rounded" />
              ) : null}
              {w.name}
            </Button>
          ))}
        </div>
        {wallet.error ? <p className="text-danger text-[13px]">{t.evmFailed}</p> : null}
      </div>
    );
  return (
    <div className="flex flex-col items-start gap-1">
      <Button size="sm" onClick={() => wallet.connect()}>
        {wallet.kind === "solana"
          ? t.connectSolana
          : wallet.kind === "near"
            ? t.connectNear
            : t.connectEvm}
      </Button>
      {wallet.error ? <p className="text-danger text-[13px]">{t.evmFailed}</p> : null}
    </div>
  );
}
