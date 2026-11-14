import { Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { FEATURE_MOCKS } from "@/components/landing/feature-mocks";
import { FEATURES, featureHref } from "@/components/landing/features-data";
import { LandingNav } from "@/components/landing/nav";
import { Reveal } from "@/components/motion/reveal";
import { LandingFooter } from "@/components/landing/sections";
import { ChainIcon, CHAINS, type ChainId } from "@/components/ui/chain-badge";
import { cn } from "@/lib/cn";

export const metadata: Metadata = {
  title: "Features: everything Openrail does",
  description:
    "Invoices and a hosted checkout paid from any chain, dashboards, receipts, statements, confidential payouts, an API with signed webhooks, store integrations and an MCP server for AI agents.",
};

const CHAIN_ROW: ChainId[] = [
  "near",
  "base",
  "arbitrum",
  "ethereum",
  "solana",
  "polygon",
  "optimism",
  "bnb",
];

/** Behind each screen: a soft wash, one of three in turn, from the page's own colours. */
const TINTS = [
  "bg-[color-mix(in_oklab,var(--accent)_12%,var(--surface))]",
  "bg-[color-mix(in_oklab,#f59e0b_14%,var(--surface))]",
  "bg-[color-mix(in_oklab,#06b6d4_14%,var(--surface))]",
];

/** A small table card, tilted at the side of the hero. */
function SideCard({ side }: { side: "left" | "right" }) {
  const rows =
    side === "left"
      ? [
          ["$1,240.00", "Paid"],
          ["$386.50", "Paid"],
          ["$96.00", "Paid"],
          ["$48.50", "Waiting"],
        ]
      : [
          ["Northwind", "$1,240"],
          ["Spectra Inc", "$386"],
          ["Alex Beck", "$96"],
          ["M. Armas", "$48"],
        ];
  return (
    <div
      aria-hidden
      className={cn(
        "absolute bottom-24 hidden w-[230px] rounded-2xl border border-accent/40 bg-surface/90 p-4 text-[11px] text-muted shadow-[0_0_40px_-12px_var(--accent)] lg:block",
        side === "left" ? "-left-10 -rotate-[14deg]" : "-right-10 rotate-[14deg]",
      )}
    >
      <p className="mb-2 font-semibold text-text">{side === "left" ? "Invoices" : "Top clients"}</p>
      {rows.map(([a, b]) => (
        <p key={a} className="flex justify-between border-t border-border py-1.5">
          <span>{a}</span>
          <span className={b === "Paid" ? "text-success-text" : ""}>{b}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * The hero, edge to edge and in the page's own colours: no box. Light mode is the ash page with soft accent bands and
 * dark text; dark mode the same bands, stronger, on black (14 Nov: a dark box on the light page did not belong).
 */
function Hero() {
  return (
    <section className="relative isolate overflow-hidden text-center text-text">
      {/* Vertical bands of the accent, brightest in the middle, fading down; across the whole width. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 [mask-image:linear-gradient(to_bottom,black,transparent_80%)]"
      >
        <div className="absolute inset-x-0 top-0 h-full [mask-image:linear-gradient(90deg,transparent,black_22%,black_78%,transparent)] bg-[repeating-linear-gradient(90deg,color-mix(in_oklab,var(--accent)_5%,transparent)_0_64px,color-mix(in_oklab,var(--accent)_11%,transparent)_64px_128px)] dark:bg-[repeating-linear-gradient(90deg,rgba(63,70,254,0.10)_0_64px,rgba(63,70,254,0.22)_64px_128px)]" />
        <div className="absolute inset-x-[25%] top-0 h-full bg-[radial-gradient(ellipse_at_top,color-mix(in_oklab,var(--accent)_28%,transparent),transparent_70%)] dark:bg-[radial-gradient(ellipse_at_top,rgba(63,70,254,0.55),transparent_70%)]" />
      </div>
      <div className="relative mx-auto max-w-[1240px] px-4 pt-20 pb-12 sm:px-6">
        <SideCard side="left" />
        <SideCard side="right" />
        <Reveal>
          <p className="mx-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/70 px-3 py-1 text-[12.5px] font-medium">
            <Sparkles aria-hidden size={13} className="text-accent" /> Everything after the payment,
            too
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h1 className="mx-auto mt-6 max-w-[16ch] text-[clamp(36px,5.4vw,64px)] leading-[1.04] font-bold tracking-[-0.03em]">
            Powerful Features Built For Getting Paid
          </h1>
        </Reveal>
        <Reveal delay={160}>
          <p className="mx-auto mt-5 max-w-[58ch] text-[16px] leading-7 text-muted">
            Bill clients and run a checkout that takes stablecoins from any chain, then keep the
            books, prove them, and move the money where you want it.
          </p>
        </Reveal>
        <Reveal delay={240}>
          <ul className="mx-auto mt-9 flex max-w-[760px] flex-wrap justify-center gap-2.5">
            {FEATURES.map((f) => (
              <li key={f.id}>
                <a
                  href={featureHref(f.id)}
                  className="inline-flex h-10 items-center rounded-full border border-border bg-surface/80 px-4 text-[13px] font-medium hover:border-accent hover:text-accent-text"
                >
                  {f.title}
                </a>
              </li>
            ))}
          </ul>
        </Reveal>
        <div className="mx-auto mt-14 flex max-w-[520px] items-center gap-3 text-[13px] font-medium text-muted">
          <span className="h-px flex-1 bg-gradient-to-r from-transparent to-border" />
          Clients pay from eight chains
          <span className="h-px flex-1 bg-gradient-to-l from-transparent to-border" />
        </div>
        <ul className="mt-6 flex flex-wrap justify-center gap-x-8 gap-y-4">
          {CHAIN_ROW.map((c) => (
            <li key={c} className="flex items-center gap-2 text-[15px] font-semibold">
              <ChainIcon chain={c} size={26} /> {CHAINS[c]}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export default function FeaturesPage() {
  return (
    <div className="min-h-dvh bg-bg text-text">
      <LandingNav />
      <main>
        <Hero />
        <div className="mx-auto max-w-[1240px] space-y-6 px-4 py-20 sm:px-6">
          {FEATURES.map((f, i) => {
            const Mock = FEATURE_MOCKS[f.id];
            const flip = i % 2 === 1;
            return (
              <section
                key={f.id}
                id={f.id}
                aria-labelledby={`${f.id}-title`}
                className="grid scroll-mt-28 grid-cols-[minmax(0,1fr)] items-center gap-8 [&>*]:min-w-0 rounded-[28px] border border-border bg-surface p-5 sm:p-8 lg:grid-cols-2 lg:gap-14"
              >
                <Reveal
                  from={flip ? "right" : "left"}
                  className={cn("lg:px-4", flip && "lg:order-2")}
                >
                  <p className="text-[13px] font-semibold text-accent-text">
                    {String(i + 1).padStart(2, "0")}
                  </p>
                  <h2
                    id={`${f.id}-title`}
                    className="mt-2 text-[clamp(26px,3.2vw,38px)] leading-[1.08] font-extrabold tracking-[-0.03em]"
                  >
                    {f.title}
                  </h2>
                  <p className="mt-4 max-w-[46ch] text-[16px] leading-7 text-muted">{f.subtitle}</p>
                  {f.href ? (
                    <a
                      href={f.href}
                      className="mt-5 inline-flex h-11 items-center rounded-full bg-accent px-5 text-[14px] font-semibold text-on-accent hover:bg-accent-hover"
                    >
                      See the Agent MCP page
                    </a>
                  ) : null}
                </Reveal>
                <Reveal
                  delay={100}
                  from={flip ? "left" : "right"}
                  className={cn(flip && "lg:order-1")}
                >
                  <div className={cn("rounded-[22px] p-4 sm:p-7", TINTS[i % TINTS.length])}>
                    {Mock ? <Mock /> : null}
                  </div>
                </Reveal>
              </section>
            );
          })}
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
