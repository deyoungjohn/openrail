"use client";

import { useState } from "react";
import { copy } from "@/copy";
import { groupWallets, type PickerPurpose } from "@/wallet/groups";
import type { NearWalletInfo } from "@/wallet/near";
import { Modal } from "./ui/modal";

function Row({
  w,
  onPick,
  disabled,
  note,
}: {
  w: NearWalletInfo;
  onPick?: () => void;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        disabled={disabled && !onPick}
        className="flex w-full items-center gap-3 rounded-[10px] border border-edge bg-row px-3 py-2.5 text-left transition-colors duration-[var(--dur-fast)] hover:border-hl-edge hover:bg-hl disabled:opacity-60"
      >
        {w.iconUrl ? (
          <img src={w.iconUrl} alt="" width={28} height={28} className="size-7 rounded-md" />
        ) : (
          <span
            aria-hidden
            className="grid size-7 place-items-center rounded-md bg-surface-2 text-[13px] font-semibold"
          >
            {w.name[0]}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] leading-5 font-medium">{w.name}</span>
          {note ? <span className="caption block">{note}</span> : null}
        </span>
      </button>
    </li>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[14px] leading-5 font-medium text-muted">{title}</h3>
      <ul className="space-y-2">{children}</ul>
    </section>
  );
}

/** Choose a NEAR wallet. For sign-in, wallets that can sign a message come first. */
export function WalletPicker({
  wallets,
  open,
  purpose = "signIn",
  onPick,
  onClose,
}: {
  wallets: readonly NearWalletInfo[];
  open: boolean;
  purpose?: PickerPurpose;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const t = copy.walletPicker;
  const g = groupWallets(wallets, purpose);
  const [refused, setRefused] = useState<string | null>(null);

  return (
    <Modal open={open} onClose={onClose} title={t.title}>
      <div className="space-y-5">
        <p className="text-[15px]">{purpose === "signIn" ? t.introSignIn : t.introConnect}</p>
        {wallets.length === 0 ? <p className="caption">{t.none}</p> : null}
        {g.usable.length > 0 ? (
          <Group title={purpose === "signIn" ? t.canSignIn : t.available}>
            {g.usable.map((w) => (
              <Row key={w.id} w={w} onPick={() => onPick(w.id)} />
            ))}
          </Group>
        ) : null}
        {g.checking.length > 0 ? (
          <Group title={t.checking}>
            {g.checking.map((w) => (
              <Row key={w.id} w={w} disabled note={t.checkingNote} />
            ))}
          </Group>
        ) : null}
        {g.cannotSign.length > 0 ? (
          <Group title={t.cannotSignIn}>
            {g.cannotSign.map((w) => (
              <Row key={w.id} w={w} onPick={() => setRefused(w.id)} />
            ))}
          </Group>
        ) : null}
        {refused ? (
          <p role="alert" className="text-danger-text text-[14px]">
            {t.cannotSign}
          </p>
        ) : null}
        {g.unavailable.length > 0 ? (
          <Group title={t.unavailable}>
            {g.unavailable.map((w) => (
              <Row key={w.id} w={w} disabled note={t.unavailableNote} />
            ))}
          </Group>
        ) : null}
      </div>
    </Modal>
  );
}
