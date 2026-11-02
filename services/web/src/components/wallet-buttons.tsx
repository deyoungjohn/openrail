"use client";

import { copy } from "@/copy";
import { useEvm } from "@/wallet/evm";
import { useNear } from "@/wallet/near";
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
        <code className="font-mono text-[13px]">{accountId}</code>
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
