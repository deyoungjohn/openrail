import { Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { FEATURE_MOCKS } from "@/components/landing/feature-mocks";
import { FEATURES } from "@/components/landing/features-data";
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
        "absolute bottom-24 hidden w-[230px] rounded-2xl border border-[#3f46fe]/50 bg-[#0d0d12]/90 p-4 text-[11px] text-[#c9cbd6] shadow-[0_0_40px_-10px_#3f46fe] lg:block",
        side === "left" ? "-left-10 -rotate-[14deg]" : "-right-10 rotate-[14deg]",
      )}
    >
      <p className="mb-2 font-semibold text-white">
        {side === "left" ? "Invoices" : "Top clients"}
      </p>
      {rows.map(([a, b]) => (
        <p key={a} className="flex justify-between border-t border-white/10 py-1.5">
          <span>{a}</span>
          <span className={b === "Paid" ? "text-[#4ade80]" : ""}>{b}</span>
        </p>
      ))}
    </div>
  );
}

function Hero() {
  return (
    // Edge to edge: the dark band spans the whole page width; only its content is held to the page column.
    <section className="relative isolate mt-2 overflow-hidden bg-[#07070a] text-center text-white">
      <div className="relative mx-auto max-w-[1240px] px-4 pt-20 pb-12 sm:px-6">
        {/* Vertical bands of the accent, brightest in the middle, fading down. */}
        <div
          aria-hidden
          className="absolute inset-0 -z-10 [mask-image:linear-gradient(to_bottom,black,transparent_75%)]"
        >
          <div className="absolute inset-x-[18%] top-0 h-full bg-[repeating-linear-gradient(90deg,rgba(63,70,254,0.10)_0_64px,rgba(63,70,254,0.22)_64px_128px)]" />
          <div className="absolute inset-x-[30%] top-0 h-full bg-[radial-gradient(ellipse_at_top,rgba(63,70,254,0.55),transparent_70%)]" />
        </div>
        <SideCard side="left" />
        <SideCard side="right" />
        <Reveal>
          <p className="mx-auto inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[12.5px] font-medium">
            <Sparkles aria-hidden size={13} className="text-[#8b90ff]" /> Everything after the
            payment, too
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h1 className="mx-auto mt-6 max-w-[16ch] text-[clamp(36px,5.4vw,64px)] leading-[1.04] font-bold tracking-[-0.03em]">
            Powerful Features Built For Getting Paid
          </h1>
        </Reveal>
        <Reveal delay={160}>
          <p className="mx-auto mt-5 max-w-[58ch] text-[16px] leading-7 text-[#b4b7c4]">
            Bill clients and run a checkout that takes stablecoins from any chain, then keep the
            books, prove them, and move the money where you want it.
          </p>
        </Reveal>
        <Reveal delay={240}>
          <ul className="mx-auto mt-9 flex max-w-[720px] flex-wrap justify-center gap-2.5">
            {FEATURES.map((f) => (
              <li key={f.id}>
                <a
                  href={`#${f.id}`}
                  className="inline-flex h-10 items-center rounded-full border border-white/12 bg-white/[0.06] px-4 text-[13px] font-medium text-[#e6e7ee] hover:border-[#8b90ff] hover:text-white"
                >
                  {f.title}
                </a>
              </li>
            ))}
          </ul>
        </Reveal>
        <div className="mx-auto mt-14 flex max-w-[520px] items-center gap-3 text-[13px] font-medium text-[#b4b7c4]">
          <span className="h-px flex-1 bg-gradient-to-r from-transparent to-white/30" />
          Clients pay from eight chains
          <span className="h-px flex-1 bg-gradient-to-l from-transparent to-white/30" />
        </div>
        <ul className="mt-6 flex flex-wrap justify-center gap-x-8 gap-y-4">
          {CHAIN_ROW.map((c) => (
            <li
              key={c}
              className="flex items-center gap-2 text-[15px] font-semibold text-[#e6e7ee]"
            >
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
