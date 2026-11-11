import { ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { copy } from "@/copy";

export const metadata: Metadata = { title: copy.page404.title };

/** Every address the site does not know: a short way back to the pages people most often want. */
export default function NotFound() {
  const t = copy.page404;
  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-4">
      <header className="flex h-16 items-center justify-between">
        <Link href="/" aria-label="Openrail">
          <Brand className="h-8 w-auto" />
        </Link>
        <ThemeToggle />
      </header>
      <main id="content" className="flex flex-1 flex-col justify-center gap-8 py-12">
        <div className="space-y-3">
          <p className="tabular text-accent-text text-[14px] font-semibold">{t.code}</p>
          <h1 className="text-[clamp(28px,6vw,48px)] leading-[1.1] font-extrabold tracking-[-0.03em]">
            {t.title}
          </h1>
          <p className="max-w-xl text-[16px] leading-6">{t.body}</p>
        </div>
        <nav aria-label={t.linksLabel}>
          <ul className="grid gap-3 sm:grid-cols-2">
            {t.links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="surface-card hover:bg-row focus-visible:ring-accent group flex h-full items-center justify-between gap-3 p-4 outline-none focus-visible:ring-2"
                >
                  <span className="min-w-0">
                    <span className="block text-[15px] font-medium">{l.title}</span>
                    <span className="caption block">{l.hint}</span>
                  </span>
                  <ArrowRight
                    aria-hidden
                    size={18}
                    className="text-muted shrink-0 transition-transform group-hover:translate-x-0.5"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <p>
          <Link href="/" className="text-accent-text text-[14px] hover:underline">
            {t.home}
          </Link>
        </p>
      </main>
    </div>
  );
}
