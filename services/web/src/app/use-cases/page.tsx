import { AlertTriangle, ArrowUpRight, CheckCircle2, ExternalLink, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { LandingNav } from "@/components/landing/nav";
import { LandingFooter } from "@/components/landing/sections";
import { Reveal } from "@/components/motion/reveal";
import { CoinIcon, ChainIcon, type ChainId } from "@/components/ui/chain-badge";
import { cn } from "@/lib/cn";

export const metadata: Metadata = {
  title: "Use cases: Shopify and WooCommerce, proven with real payments",
  description:
    "Two real stores for one demo business took stablecoin payments through Openrail on NEAR mainnet: a Shopify store and a WooCommerce store. How each works, what it proved, and its limits.",
};

const H2 = "text-[clamp(28px,4vw,44px)] leading-[1.05] font-extrabold tracking-[-0.03em]";

interface Store {
  id: string;
  name: string;
  tagline: string;
  url: string;
  urlNote: string;
  install: string;
  steps: string[];
  proved: { text: string; coin: string; chain: ChainId }[];
  limits: string[];
  docs: string;
}

const STORES: Store[] = [
  {
    id: "shopify",
    name: "Shopify",
    tagline:
      "A Shopify app adds a stablecoin option at checkout and a pay block on the order page.",
    url: "https://belmonte-apparels.myshopify.com",
    urlNote: "A development store: the storefront password is in the README.",
    install:
      "The merchant installs the Openrail app, adds the manual payment method “Pay with stablecoins (Openrail)”, and puts the Openrail block on the Thank you and Order status pages.",
    steps: [
      "The buyer adds items to the cart and checks out, choosing “Pay with stablecoins (Openrail)”.",
      "The order is placed. The Openrail block on the order page shows “Pay with stablecoins”.",
      "The buyer picks a coin and a chain on Openrail’s hosted checkout and pays from a wallet or an exchange.",
      "The payment is booked on NEAR and Openrail’s pay page shows it as paid. Openrail sends the app a signed webhook for the order.",
    ],
    proved: [
      {
        text: "A $28.00 order paid in USDT on BNB Chain, booked on NEAR mainnet",
        coin: "USDT",
        chain: "bnb",
      },
      {
        text: "The merchant still received USDC: a different coin and chain changed nothing for the store",
        coin: "USDC",
        chain: "near",
      },
    ],
    limits: [
      "Not a native Shopify gateway. That needs Shopify’s Payments Partner approval, so the buyer chooses a manual payment method and pays from the order page.",
      "The order is not marked Paid in Shopify yet. Marking it paid needs Shopify’s protected customer data access, which is not granted; the payment itself is booked and shown on Openrail.",
      "Buyer names are protected data, so these checkouts show “Store customer” in the dashboard.",
      "USD stores only, and the demo is a development store behind a password.",
    ],
    docs: "/docs/shopify",
  },
  {
    id: "woocommerce",
    name: "WooCommerce",
    tagline:
      "A WordPress plugin makes Openrail a payment method at checkout, with the result on the order page.",
    url: "https://belmonte.incepture.dev",
    urlNote: "Open to anyone: browse, add to the cart and check out.",
    install:
      "The merchant uploads the Openrail plugin, pastes an API key and the webhook secret in WooCommerce → Settings → Payments, and turns the method on.",
    steps: [
      "The buyer adds items to the cart and chooses “Pay with stablecoins” at checkout.",
      "The plugin creates one Openrail checkout for the order total and sends the buyer to the hosted pay page.",
      "The buyer picks a coin and a chain and pays from a wallet; the price is fixed before paying.",
      "The payment is booked on NEAR. The plugin checks the signed webhook and completes the order; the order page says “Your payment is confirmed on NEAR”.",
    ],
    proved: [
      {
        text: "A $48.50 order paid in USDC on Arbitrum, booked on NEAR mainnet",
        coin: "USDC",
        chain: "arbitrum",
      },
      {
        text: "The order completed on its own from the signed webhook, with no one touching the store",
        coin: "USDC",
        chain: "near",
      },
    ],
    limits: [
      "The plugin is installed from a zip; it is not in the WordPress.org directory yet.",
      "USD stores only. A payment below the order total, a partial one or a late one puts the order on hold for the merchant to review instead of completing it.",
      "Confirmation can take about a minute, longer for USDT, and the swap provider sometimes refuses a quote for a route; the buyer then picks another coin or chain.",
    ],
    docs: "/docs/woocommerce",
  },
];

/** How the two demo stores used Openrail, what that proved, and what still has limits. */
export default function UseCasesPage() {
  return (
    <div className="min-h-dvh bg-bg text-text">
      <LandingNav />
      <main>
        <section className="mx-auto max-w-[1240px] px-4 pt-12 pb-8 sm:px-6">
          <Reveal>
            <p className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent-soft px-3 py-1 text-[12.5px] font-semibold text-accent-text">
              <ShieldCheck aria-hidden size={14} /> Real stores · real money · NEAR mainnet
            </p>
            <h1 className="mt-5 max-w-[18ch] text-[clamp(38px,5.4vw,68px)] leading-[1.02] font-extrabold tracking-[-0.03em]">
              Proven On Two Real Stores, With Real Payments
            </h1>
          </Reveal>
          <Reveal delay={100}>
            <p className="mt-6 max-w-[64ch] text-[17px] leading-7 text-muted">
              To prove the technology works, the developer opened two stores for one demo business,
              Belmonte Apparels: one on Shopify, one on WooCommerce. Buyers paid them in real
              stablecoins from different chains, and every payment was booked onchain, where{" "}
              <Link href="/proof" className="text-accent-text hover:underline">
                anyone can check it
              </Link>
              . Here is how each store works, what it proved, and what still has limits.
            </p>
          </Reveal>
          <Reveal delay={180}>
            <nav aria-label="Stores" className="mt-8 flex flex-wrap gap-2.5">
              {STORES.map((s, i) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className={cn(
                    "inline-flex h-11 items-center rounded-full px-5 text-[14px] font-semibold",
                    i === 0
                      ? "bg-accent text-on-accent hover:bg-accent-hover"
                      : "border border-border bg-surface hover:bg-surface-2",
                  )}
                >
                  {s.name}
                </a>
              ))}
            </nav>
          </Reveal>
        </section>

        {STORES.map((s) => (
          <section
            key={s.id}
            id={s.id}
            aria-labelledby={`${s.id}-title`}
            className="mx-auto max-w-[1240px] scroll-mt-28 px-4 py-12 sm:px-6"
          >
            <div className="rounded-[28px] border border-border bg-surface p-6 sm:p-10">
              <Reveal>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 id={`${s.id}-title`} className={H2}>
                      {s.name}
                    </h2>
                    <p className="mt-3 max-w-[60ch] text-[16px] leading-7 text-muted">
                      {s.tagline}
                    </p>
                  </div>
                  <div className="text-right">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-[14px] font-semibold text-on-accent hover:bg-accent-hover"
                    >
                      Visit the store <ExternalLink aria-hidden size={15} />
                    </a>
                    <p className="caption mt-2 max-w-[30ch]">{s.urlNote}</p>
                  </div>
                </div>
              </Reveal>

              <div className="mt-10 grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
                <Reveal from="left">
                  <h3 className="text-[18px] font-semibold">How it was applied</h3>
                  <p className="mt-2 text-[15px] leading-6 text-muted">{s.install}</p>
                  <ol className="mt-6 space-y-4">
                    {s.steps.map((step, i) => (
                      <li key={step} className="flex gap-4">
                        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-[14px] font-bold text-accent-text">
                          {i + 1}
                        </span>
                        <span className="pt-1 text-[15.5px] leading-6">{step}</span>
                      </li>
                    ))}
                  </ol>
                </Reveal>

                <div className="space-y-5">
                  <Reveal from="right">
                    <div className="rounded-2xl border border-border bg-bg/60 p-5">
                      <h3 className="flex items-center gap-2 text-[16px] font-semibold">
                        <CheckCircle2 aria-hidden size={18} className="text-success-text" /> What it
                        proved
                      </h3>
                      <ul className="mt-4 space-y-3">
                        {s.proved.map((p) => (
                          <li
                            key={p.text}
                            className="flex items-start gap-3 text-[14.5px] leading-6"
                          >
                            <span className="relative mt-0.5 shrink-0">
                              <CoinIcon asset={p.coin} size={22} />
                              <span className="absolute -right-1.5 -bottom-1 rounded-full ring-2 ring-surface">
                                <ChainIcon chain={p.chain} size={12} />
                              </span>
                            </span>
                            <span>{p.text}</span>
                          </li>
                        ))}
                      </ul>
                      <Link
                        href="/proof"
                        className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-semibold text-accent-text hover:underline"
                      >
                        See the transactions <ArrowUpRight aria-hidden size={15} />
                      </Link>
                    </div>
                  </Reveal>
                  <Reveal from="right" delay={80}>
                    <div className="rounded-2xl border border-border bg-bg/60 p-5">
                      <h3 className="flex items-center gap-2 text-[16px] font-semibold">
                        <AlertTriangle aria-hidden size={17} className="text-[#d97706]" /> Honest
                        limitations
                      </h3>
                      <ul className="mt-4 space-y-3">
                        {s.limits.map((l) => (
                          <li key={l} className="flex gap-3 text-[14.5px] leading-6 text-muted">
                            <span
                              aria-hidden
                              className="mt-[10px] size-1.5 shrink-0 rounded-full bg-[#d97706]"
                            />
                            <span>{l}</span>
                          </li>
                        ))}
                      </ul>
                      <a
                        href={s.docs}
                        className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-semibold text-accent-text hover:underline"
                      >
                        Read the {s.name} docs <ArrowUpRight aria-hidden size={15} />
                      </a>
                    </div>
                  </Reveal>
                </div>
              </div>
            </div>
          </section>
        ))}

        <section className="mx-auto max-w-[1240px] px-4 pt-6 pb-24 text-center sm:px-6">
          <Reveal>
            <h2 className={H2}>Any Other Store</h2>
            <p className="mx-auto mt-4 max-w-[56ch] text-[16px] leading-7 text-muted">
              Both plugins use the same public API. Any store or app can do the same with one call
              to create a checkout and one signed webhook to hear it was paid.
            </p>
            <Link
              href="/developers"
              className="mt-8 inline-flex h-12 items-center gap-2 rounded-full border border-border bg-surface px-6 text-[15px] font-semibold hover:bg-surface-2"
            >
              See the Quickstart <ArrowUpRight aria-hidden size={16} />
            </Link>
          </Reveal>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
