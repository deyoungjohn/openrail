"use client";

import { QRCodeSVG } from "qrcode.react";
import { copy } from "@/copy";
import type { ViewState } from "./card";
import { AddressChip } from "./address-chip";
import type { ChainId } from "./chain-badge";
import { ErrorState, Skeleton } from "./state";

export function QrPanel({
  address,
  amount,
  chain,
  qrValue,
  state = "ready",
}: {
  address: string;
  /** Display string, e.g. "25.00 USDC". */
  amount: string;
  chain?: ChainId;
  /** What the QR encodes; defaults to the address. */
  qrValue?: string;
  state?: ViewState;
}) {
  return (
    <div className="surface-card flex flex-col items-center gap-4 p-6 text-center">
      {state === "loading" ? (
        <div role="status" aria-busy className="flex flex-col items-center gap-3">
          <Skeleton className="size-[184px]" />
          <Skeleton className="h-5 w-40" />
        </div>
      ) : state === "error" || state === "empty" ? (
        <ErrorState body="We couldn't create the payment address. Reload the page to try again." />
      ) : (
        <>
          {/* Always white behind the code so it scans in dark mode. */}
          <div className="rounded-xl bg-white p-3">
            <QRCodeSVG
              value={qrValue ?? address}
              size={160}
              level="M"
              title={`${copy.qr.address}: ${address}`}
            />
          </div>
          <div>
            <p className="caption">{copy.qr.amount}</p>
            <p className="tabular text-[28px] leading-[1.1] font-bold">{amount}</p>
          </div>
          <div className="max-w-full">
            <p className="caption">{copy.qr.address}</p>
            <AddressChip value={address} chain={chain} head={8} tail={6} />
          </div>
        </>
      )}
    </div>
  );
}
