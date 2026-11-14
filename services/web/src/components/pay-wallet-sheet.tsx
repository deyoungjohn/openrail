"use client";

import { copy } from "@/copy";
import { Modal } from "./ui/modal";

interface Choice {
  id: string;
  name: string;
  icon: string;
}

function Row({
  name,
  icon,
  onPick,
  note,
}: {
  name: string;
  icon?: string;
  onPick?: () => void;
  note?: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        disabled={!onPick}
        className="flex w-full items-center gap-3 rounded-[10px] border border-edge bg-row px-3 py-2.5 text-left transition-colors duration-[var(--dur-fast)] hover:border-hl-edge hover:bg-hl disabled:opacity-60"
      >
        {icon ? (
          <img src={icon} alt="" width={28} height={28} className="size-7 rounded-md" />
        ) : (
          <span
            aria-hidden
            className="grid size-7 place-items-center rounded-md bg-surface-2 text-[13px] font-semibold"
          >
            {name[0]}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] leading-5 font-medium">{name}</span>
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

/**
 * The pay page's wallet sheet for EVM and Solana routes: the same sheet as the NEAR sign-in picker, with the wallets
 * this browser has, then the ones it does not (14 Nov: a dozen wallet buttons in the page were too many).
 */
export function PayWalletSheet({
  open,
  family,
  choices,
  missing,
  onPick,
  onClose,
}: {
  open: boolean;
  family: "evm" | "solana";
  choices: readonly Choice[];
  missing: readonly { id: string; name: string }[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const t = copy.wallet;
  return (
    <Modal open={open} onClose={onClose} title={t.sheetTitle}>
      <div className="space-y-5">
        <p className="text-[15px]">{family === "solana" ? t.sheetIntroSolana : t.sheetIntroEvm}</p>
        {choices.length === 0 ? <p className="caption">{t.noWalletForRoute}</p> : null}
        {choices.length > 0 ? (
          <Group title={t.inBrowser}>
            {choices.map((w) => (
              <Row key={w.id} name={w.name} icon={w.icon} onPick={() => onPick(w.id)} />
            ))}
          </Group>
        ) : null}
        {missing.length > 0 ? (
          <Group title={t.notInstalled}>
            {missing.map((w) => (
              <Row key={w.id} name={w.name} note={t.notInstalledNote} />
            ))}
          </Group>
        ) : null}
        <p className="caption">{t.sameAccountNote}</p>
      </div>
    </Modal>
  );
}
