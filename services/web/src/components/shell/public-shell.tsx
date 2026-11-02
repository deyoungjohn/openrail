import Link from "next/link";
import type { ReactNode } from "react";
import { copy } from "@/copy";
import { Brand } from "../brand";
import { ThemeToggle } from "../ui/theme-toggle";

/** Frame for pages clients open from a link (ack, pay, receipt). Mobile first, no login. */
export function PublicShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const width = wide ? "max-w-[1040px]" : "${width}";
  return (
    <div className="flex min-h-dvh flex-col">
      <header className={`mx-auto flex h-14 w-full ${width} items-center justify-between px-4`}>
        <Link href="/">
          <Brand />
        </Link>
        <ThemeToggle />
      </header>
      <main className={`route-rise mx-auto w-full ${width} flex-1 px-4 py-6`}>{children}</main>
      <footer className={`mx-auto w-full ${width} px-4 py-6`}>
        <p className="caption">{copy.publicShell.footer}</p>
      </footer>
    </div>
  );
}
