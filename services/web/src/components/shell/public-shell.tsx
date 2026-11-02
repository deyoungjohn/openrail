import Link from "next/link";
import type { ReactNode } from "react";
import { copy } from "@/copy";
import { ThemeToggle } from "../ui/theme-toggle";

/** Frame for pages clients open from a link (ack, pay, receipt). Mobile first, no login. */
export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex h-14 w-full max-w-[640px] items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2 text-[16px] font-semibold">
          <span aria-hidden className="size-5 rounded-md bg-accent" />
          {copy.brand}
        </Link>
        <ThemeToggle />
      </header>
      <main className="route-rise mx-auto w-full max-w-[640px] flex-1 px-4 py-6">{children}</main>
      <footer className="mx-auto w-full max-w-[640px] px-4 py-6">
        <p className="caption">{copy.publicShell.footer}</p>
      </footer>
    </div>
  );
}
