import { ArrowUpRight, FileText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { LandingNav } from "@/components/landing/nav";
import { Reveal } from "@/components/motion/reveal";
import { LandingFooter } from "@/components/landing/sections";
import { CHECK, INTRO, LINKS, STEPS } from "@/lib/how-it-works";

export const metadata: Metadata = {
  title: "How Openrail works",
  description:
    "Openrail in six steps: ask to be paid, your client pays from any chain, the contract books it on NEAR, the money reaches you, the records keep themselves. Also at /how-it-works.md.",
  alternates: { types: { "text/markdown": "/how-it-works.md" } },
};

/** The docs, short and plain, for anyone (and as Markdown at /how-it-works.md for agents). */
export default function HowItWorksPage() {
  return (
    <div className="min-h-dvh bg-bg text-text">
      <LandingNav />
      <main className="mx-auto max-w-[880px] px-4 pt-10 pb-24 sm:px-6">
        <p className="text-[14px] font-semibold text-accent-text">How it works</p>
        <h1 className="mt-2 text-[clamp(36px,6vw,64px)] leading-[1.02] font-extrabold tracking-[-0.03em]">
          From Pay Link To Your Wallet
        </h1>
        <p className="mt-5 text-[17px] leading-7 text-muted">{INTRO}</p>
        <p className="mt-4 inline-flex flex-wrap items-center gap-1.5 text-[14px] text-muted">
          <FileText aria-hidden size={15} /> For agents and language models, the same page is at{" "}
          <a href="/how-it-works.md" className="font-mono text-accent-text hover:underline">
            /how-it-works.md
          </a>
        </p>

        <ol className="mt-12 space-y-4">
          {STEPS.map((s, i) => (
            <li key={s.id} id={s.id} className="scroll-mt-28">
              <Reveal delay={(i % 2) * 60}>
                <article className="rounded-[22px] border border-border bg-surface p-6 sm:p-8">
                  <h2 className="text-[clamp(22px,2.6vw,28px)] leading-[1.15] font-extrabold tracking-[-0.02em]">
                    {s.title}
                  </h2>
                  <ul className="mt-4 space-y-2.5">
                    {s.body.map((b) => (
                      <li key={b} className="flex gap-3 text-[16px] leading-7 text-muted">
                        <span
                          aria-hidden
                          className="mt-[11px] size-1.5 shrink-0 rounded-full bg-accent"
                        />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              </Reveal>
            </li>
          ))}
        </ol>

        <section aria-labelledby="check" className="mt-12">
          <h2 id="check" className="text-[clamp(24px,3vw,32px)] font-extrabold tracking-[-0.02em]">
            How To Check It
          </h2>
          <ul className="mt-4 space-y-2.5">
            {CHECK.map((c) => (
              <li key={c} className="flex gap-3 text-[16px] leading-7 text-muted">
                <span aria-hidden className="mt-[11px] size-1.5 shrink-0 rounded-full bg-accent" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="more" className="mt-12">
          <h2 id="more" className="text-[clamp(24px,3vw,32px)] font-extrabold tracking-[-0.02em]">
            Read More
          </h2>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {LINKS.map(([label, href]) => {
              const external = href.startsWith("http");
              return (
                <li key={href}>
                  <a
                    href={href}
                    {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                    className="flex min-h-12 items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-[15px] font-medium hover:bg-surface-2"
                  >
                    {label}
                    <ArrowUpRight aria-hidden size={15} className="shrink-0 text-muted" />
                  </a>
                </li>
              );
            })}
          </ul>
          <Link
            href="/app"
            className="mt-10 inline-flex h-14 items-center rounded-full bg-accent px-6 text-[15px] font-semibold text-on-accent hover:bg-accent-hover"
          >
            Open the app
          </Link>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
