"use client";

import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Bot,
  Code2,
  FileCheck2,
  FileSpreadsheet,
  Lock,
  ShoppingCart,
  Store,
} from "lucide-react";
import { BouncyAccordion } from "@/components/ui/bouncy-accordion";
import { ChainIcon, CHAINS, CoinIcon, type ChainId } from "@/components/ui/chain-badge";
import { FEATURES as FEATURE_LIST, featureHref } from "./features-data";
import { Reveal } from "./reveal";
import { Ring, type RingItem } from "./ring";

const H2 = "text-[clamp(28px,4vw,44px)] leading-[1.05] font-extrabold tracking-[-0.03em]";
const BODY = "text-[15px] leading-6 font-normal text-muted";

/** Ten marks: the eight chains clients pay from and the two stablecoins. */
const MARKS: { key: string; label: string; icon: ReactNodeLike }[] = [
  ...(
    ["near", "base", "arbitrum", "ethereum", "solana", "polygon", "optimism", "bnb"] as ChainId[]
  ).map((c) => ({
    key: c,
    label: CHAINS[c],
    icon: { chain: c },
  })),
  { key: "usdc", label: "USDC", icon: { coin: "USDC" } },
  { key: "usdt", label: "USDT", icon: { coin: "USDT" } },
];
type ReactNodeLike = { chain: ChainId } | { coin: string };

/** The chains and coins, sliding left to right without end, under a one-line caption. */
export function ChainsMarquee() {
  const loop = [...MARKS, ...MARKS, ...MARKS];
  return (
    <section
      aria-label="Chains and coins clients pay with"
      className="border-y border-border bg-surface py-10"
    >
      <p className="text-center text-[14px] leading-5 font-medium text-muted">
        Clients pay from the chain their money is on
      </p>
      <div className="mt-8 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_10%,black_90%,transparent)]">
        <ul className="flex w-max gap-14 motion-safe:animate-[landing-marquee-left_40s_linear_infinite]">
          {loop.map((m, i) => (
            <li
              key={`${m.key}-${i}`}
              className="flex w-[96px] shrink-0 flex-col items-center gap-3"
            >
              {"chain" in m.icon ? (
                <ChainIcon chain={m.icon.chain} size={56} />
              ) : (
                <CoinIcon asset={m.icon.coin} size={56} />
              )}
              <span className="text-[14px] font-medium whitespace-nowrap">{m.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** A drawn confidential-balance screen (the live one needs a wallet signature, so the ring shows this). */
function PrivateBalanceMock() {
  const rows: [string, string, string][] = [
    ["Nov 13, 2026", "$30.00", "Withdrawn"],
    ["Nov 13, 2026", "$26.93", "In your confidential balance"],
    ["Nov 13, 2026", "$27.93", "In your confidential balance"],
    ["Nov 13, 2026", "$9.97", "In your confidential balance"],
  ];
  return (
    <div className="flex size-full flex-col gap-3 bg-[#0b0b0f] p-5 text-[#eef0f6]">
      <div className="grid grid-cols-4 gap-2.5">
        {[
          ["Held", "$0.00"],
          ["On its way", "$0.00"],
          ["In your confidential balance", "$86.80"],
          ["Returned", "$0.00"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-[#2b2b33] bg-[#121216] p-3">
            <p className="text-[10.5px] text-[#9aa3b2]">{k}</p>
            <p
              className={`mt-1 text-[20px] font-bold ${k === "In your confidential balance" ? "text-[#8b90ff]" : ""}`}
            >
              {v}
            </p>
          </div>
        ))}
      </div>
      <div className="flex-1 rounded-xl border border-[#2b2b33] bg-[#121216] p-3">
        <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
          <Lock aria-hidden size={13} /> Where your money is
        </p>
        {rows.map((r, i) => (
          <div
            key={i}
            className="flex justify-between border-t border-[#2b2b33] py-2 text-[11.5px]"
          >
            <span className="text-[#9aa3b2]">{r[0]}</span>
            <span className="font-medium">{r[1]}</span>
            <span className="w-[150px] text-right">{r[2]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const SCREENS: RingItem[] = [
  {
    title: "Dashboard and analytics",
    description: "Revenue by month, weekly activity, top clients, and where each client paid from.",
    image: "/landing/invoices.webp",
  },
  {
    title: "Statements",
    description: "A PDF for any period, every payment listed, with a fingerprint you can check.",
    image: "/landing/statements.webp",
  },
  {
    title: "Cash out",
    description: "Send USDC from your balance to any chain you choose, in one signature.",
    image: "/landing/public_payout.webp",
  },
  {
    title: "Confidential balance",
    description: "Payments move to a balance only you can see, and leave it when you say.",
    node: <PrivateBalanceMock />,
  },
  {
    title: "Payout settings",
    description: "Choose when held payments move: after each payment, daily, weekly or monthly.",
    image: "/landing/payout_settings.webp",
  },
  {
    title: "API keys and webhooks",
    description: "Signed webhooks tell your store the moment an order is paid.",
    image: "/landing/webhooks.webp",
  },
];

/** The app, screen by screen, on a ring. */
export function Showcase() {
  return (
    <section className="mx-auto max-w-[1240px] px-4 py-24 sm:px-6">
      <Reveal>
        <p className="text-center text-[14px] font-medium text-muted">Inside the app</p>
        <h2 className={`mt-2 text-center ${H2}`}>Everything After The Payment</h2>
      </Reveal>
      <Reveal delay={120} className="mt-12">
        <Ring items={SCREENS} />
      </Reveal>
    </section>
  );
}

const ICONS: Record<string, typeof BarChart3> = {
  dashboards: BarChart3,
  receipts: FileCheck2,
  statements: FileSpreadsheet,
  confidential: Lock,
  api: Code2,
  stores: Store,
  checkout: ShoppingCart,
  agents: Bot,
};
// The landing cards: the features with a card line, each pointing at its section on the Features page.
const CARDS = FEATURE_LIST.filter((f) => f.card !== undefined && ICONS[f.id] !== undefined);

/** What a business gets beyond being paid. */
export function Features() {
  return (
    <section className="mx-auto max-w-[1240px] px-4 sm:px-6">
      <Reveal>
        <h2 className={H2}>Built For The Whole Money Flow</h2>
        <p className={`mt-4 max-w-[60ch] ${BODY}`}>
          Getting paid is the start. Openrail keeps the books, proves them, and moves the money
          where you want it.
        </p>
      </Reveal>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {CARDS.map((f, i) => {
          const Icon = ICONS[f.id] as typeof BarChart3;
          return (
            <Reveal key={f.id} delay={(i % 3) * 100}>
              <a
                href={featureHref(f.id)}
                className="group block h-full rounded-[22px] border border-border bg-surface p-6 transition-colors hover:border-accent"
              >
                <span className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent-text">
                  <Icon aria-hidden size={20} />
                </span>
                <h3 className="mt-5 text-[18px] leading-[26px] font-semibold">{f.title}</h3>
                <p className={`mt-2 ${BODY}`}>{f.card}</p>
                <span className="mt-4 inline-flex items-center gap-1 text-[14px] font-medium text-accent-text">
                  Learn more
                  <ArrowRight
                    aria-hidden
                    size={15}
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </span>
              </a>
            </Reveal>
          );
        })}
      </div>
      <Reveal className="mt-8 flex justify-center">
        <a
          href="/features"
          className="group inline-flex h-14 items-center gap-3 rounded-full bg-accent py-2 pr-2 pl-6 text-[15px] font-medium text-on-accent hover:bg-accent-hover"
        >
          See all features
          <span className="grid size-10 place-items-center rounded-full bg-on-accent text-accent transition-transform group-hover:rotate-45">
            <ArrowUpRight aria-hidden size={18} />
          </span>
        </a>
      </Reveal>
    </section>
  );
}

const QA = [
  {
    q: "Who holds the money?",
    a: "Nobody but you. A payment lands in the invoice's own account on NEAR and the contract moves it only to the business that issued it. Openrail's services hold gas, never your funds.",
  },
  {
    q: "Which chains and coins can my clients pay with?",
    a: "USDC and USDT from NEAR, Base, Arbitrum, Ethereum, Solana, Polygon, Optimism and BNB Chain, plus ETH, SOL and NEAR. You receive USDC on the chain you choose.",
  },
  {
    q: "What does it cost?",
    a: "0.25% per payment. Network fees are tiny and the swap fee is shown before your client pays. No monthly fee.",
  },
  {
    q: "How do I know a payment is real?",
    a: "Every payment is booked by the contract openrail.near on NEAR mainnet. Each receipt links to the transactions on the explorer, and the Proof page lists recent ones.",
  },
  {
    q: "Can I keep my balance confidential?",
    a: "Yes. Turn on the confidential balance and payments move to NEAR Intents' confidential balance, which only you can see. Withdraw from it to any supported chain.",
  },
  {
    q: "Does it work with my store?",
    a: "There is a WooCommerce plugin and a Shopify app. Any other store or app creates a checkout with one API call and gets a signed webhook when it is paid.",
  },
  {
    q: "Can an AI agent use it?",
    a: "Yes. The MCP server lets an agent issue invoices, open checkouts and check what was paid, with the same rules as the API.",
  },
];

export function Faq() {
  return (
    <section className="mx-auto grid max-w-[1240px] gap-10 px-4 py-24 sm:px-6 lg:grid-cols-[1fr_1.4fr]">
      <Reveal>
        <p className="text-[14px] font-medium text-muted">Questions</p>
        <h2 className={`mt-2 ${H2}`}>Got Questions? We've Got Answers</h2>
        <p className={`mt-4 max-w-[40ch] ${BODY}`}>
          Something else? The code and the docs are open on GitHub.
        </p>
      </Reveal>
      <Reveal delay={120}>
        <BouncyAccordion
          defaultValue="q0"
          items={QA.map((x, i) => ({ id: `q${i}`, title: x.q, description: x.a }))}
        />
      </Reveal>
    </section>
  );
}
