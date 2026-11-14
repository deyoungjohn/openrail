import { ArrowRight, ArrowUpRight, ExternalLink, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Brand, BrandMark } from "@/components/brand";
import {
  nearAccountUrl,
  nearTxUrl,
  PROOF_CONTRACT,
  PROOF_ROWS,
  type ProofRow,
} from "@/lib/proof-data";
import { CoinCards, FauxAgent, FauxDashboard, FauxInvoice, FauxPay, Toast } from "./faux";
import { Globe } from "./globe/globe";
import { MENUS, REPO_URL } from "./links";
import { CountUp } from "./count-up";
import { Reveal } from "./reveal";

/** H2 (landing section): clamp(28px, 4vw, 44px) / 1.05, 800, upper case, tracking -0.03em. */
const H2 = "text-[clamp(28px,4vw,44px)] leading-[1.05] font-extrabold tracking-[-0.03em]";
/** Card titles on the landing page: the H2 face, one step down. */
const H2_CARD = "text-[clamp(24px,2.6vw,32px)] leading-[1.05] font-extrabold tracking-[-0.03em]";
/** Body large (landing): 18 / 28, 400. */
const BODY_L = "text-[18px] leading-7 font-normal text-muted";
/** Body: 15 / 24, 400. */
const BODY = "text-[15px] leading-6 font-normal text-muted";

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      {/* A faint grid behind the hero (no colour wash). */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 [background-image:linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] [background-size:56px_56px] opacity-40 [mask-image:radial-gradient(ellipse_at_30%_20%,black,transparent_70%)]"
      />
      <div className="mx-auto max-w-[1240px] px-4 pt-10 sm:px-6 sm:pt-14">
        <div className="grid items-center gap-8 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <Reveal>
              <p className="inline-flex items-center gap-2 rounded-full border border-border bg-surface p-1 pr-3 text-[13px] font-medium">
                <span className="rounded-full bg-accent px-2.5 py-1 text-on-accent">
                  Built on NEAR
                </span>
                <span className="text-accent-text">Stablecoin payments for businesses</span>
              </p>
            </Reveal>
            <Reveal delay={80}>
              <h1 className="mt-6 text-[clamp(38px,4.6vw,64px)] leading-[1.02] font-bold tracking-[-0.03em] text-text">
                Get Paid In Stablecoins. <span className="block text-accent">From Any Chain.</span>
              </h1>
            </Reveal>
            <Reveal delay={160}>
              <p className={`mt-6 max-w-[52ch] ${BODY_L}`}>
                Invoices and checkout for businesses. Clients pay from eight chains; you receive
                USDC where you choose, and every payment is proven on NEAR.
              </p>
            </Reveal>
            <Reveal delay={240}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href="/app"
                  className="group inline-flex h-14 items-center gap-3 rounded-full bg-accent py-2 pr-2 pl-6 text-[15px] font-medium text-on-accent hover:bg-accent-hover"
                >
                  Start for free
                  <span className="grid size-10 place-items-center rounded-full bg-on-accent text-accent transition-transform group-hover:rotate-45">
                    <ArrowUpRight aria-hidden size={18} />
                  </span>
                </Link>
                <Link
                  href="/proof"
                  className="inline-flex h-14 items-center gap-2 rounded-full border border-border bg-surface px-6 text-[15px] font-medium hover:bg-surface-2"
                >
                  <ShieldCheck aria-hidden size={18} className="text-accent" /> See the proof
                </Link>
              </div>
            </Reveal>
          </div>
          <Reveal delay={120} className="mx-auto w-full max-w-[680px] lg:-mr-10">
            <Globe />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/** The dashboard in a browser frame: a section of its own, with room above and below. */
export function DashboardShot() {
  return (
    <section aria-label="The Openrail dashboard" className="px-4 pt-24 pb-28 sm:px-6">
      <Reveal className="relative mx-auto max-w-[1080px]">
        <FauxDashboard />
        <Toast
          className="absolute -top-12 -left-20 hidden xl:flex"
          title="Order #46 paid"
          sub="WooCommerce · from Arbitrum"
          amount="$128.40"
          chain="arbitrum"
        />
        <Toast
          className="absolute top-[-24px] -right-20 hidden xl:flex"
          title="Invoice #4802461 paid"
          sub="Connor Wickham · from Solana"
          amount="$240.00"
          chain="solana"
        />
      </Reveal>
    </section>
  );
}

function Card({
  id,
  title,
  body,
  delay = 0,
  children,
}: {
  id?: string;
  delay?: number;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <Reveal delay={delay}>
      <article
        id={id}
        className="h-full scroll-mt-24 overflow-hidden rounded-[28px] border border-border bg-surface p-7 sm:p-9"
      >
        <h3 className={H2_CARD}>{title}</h3>
        <p className={`mt-3 max-w-[46ch] ${BODY}`}>{body}</p>
        <div className="mt-8 flex min-h-[250px] items-end justify-center">{children}</div>
      </article>
    </Reveal>
  );
}

/** Two products side by side (the reference's two cards). */
export function TwoCards() {
  return (
    <section className="mx-auto grid max-w-[1240px] gap-5 px-4 py-20 sm:px-6 lg:grid-cols-2">
      <Card
        id="invoices"
        title="Bill Any Client, On Any Chain"
        body="Send an invoice with its lines and due date. Your client pays from the chain their money is on; the payment lands in the invoice's own account on NEAR and is booked to you."
      >
        <div className="relative flex w-full justify-center pt-12 xl:justify-start xl:pl-6">
          <FauxInvoice />
          <Toast
            className="absolute top-0 right-0 hidden xl:flex"
            title="Paid in full"
            sub="from Solana · booked on NEAR"
            amount="$240.00"
            chain="solana"
          />
        </div>
      </Card>
      <Card
        id="checkout"
        delay={120}
        title="Accept Stablecoins At Checkout"
        body="A hosted checkout for every order: USDC or USDT from eight chains, settled in the asset you choose. Ready for Shopify and WooCommerce."
      >
        <CoinCards />
      </Card>
    </section>
  );
}

/** Dots in the shape of the continents (a coarse equirectangular mask). */
const MAP = [
  "                                                            ",
  "         ......        ..     .......................       ",
  "      ..............  ....   ..........................     ",
  "     ...............   ..   ............................    ",
  "      .............         ...........................     ",
  "       ...........         ............................     ",
  "        .........          ...... ......................    ",
  "         ......            .....   .................  .     ",
  "          ....              .....   ...............         ",
  "           ...               ....    ....   .......         ",
  "            ....              ...           .....   ...     ",
  "             .....             .              ..    ....    ",
  "             ......                                .....    ",
  "              .....                                 ...     ",
  "              ....                                          ",
  "              ..                                            ",
];

export function Global() {
  return (
    <section className="mx-auto max-w-[1240px] px-4 sm:px-6" id="any-store">
      <div className="grid items-center gap-10 overflow-hidden rounded-[28px] border border-border bg-surface p-7 sm:p-10 lg:grid-cols-[1fr_1.2fr]">
        <div>
          <p className="text-[14px] font-medium text-accent-text">Global by default</p>
          <h2 className={`mt-3 break-words ${H2}`}>Sell Everywhere. Get Paid In One Place.</h2>
          <p className={`mt-5 max-w-[48ch] ${BODY}`}>
            A buyer in Lagos pays from Solana, one in Austin from Base, one in Seoul from NEAR. You
            set one settlement asset and receive it, whatever chain they used. Any store can do it
            with one API call.
          </p>
          <pre className="mt-6 overflow-x-auto rounded-2xl bg-[#0b0d17] p-4 text-[12.5px] leading-5 text-[#d6dbff]">{`curl -X POST $API/v1/checkouts \\
  -H "Authorization: Bearer $KEY" \\
  -d '{"order_ref":"A-1001","amount_usd":"28.00"}'`}</pre>
        </div>
        <div className="relative min-h-[340px]">
          <div
            aria-hidden
            className="absolute inset-x-0 top-6 grid gap-[4px] text-accent/35 [grid-template-columns:repeat(60,minmax(0,1fr))]"
          >
            {MAP.join("")
              .split("")
              .map((ch, i) => (
                <i
                  key={i}
                  className={ch === "." ? "aspect-square rounded-full bg-current" : "aspect-square"}
                />
              ))}
          </div>
          <Toast
            className="absolute top-0 left-0"
            title="Order paid"
            sub="Austin · from Base"
            amount="$128.40"
            chain="base"
          />
          <Toast
            className="absolute top-[34%] left-[30%]"
            title="Invoice paid"
            sub="Lagos · from Solana"
            amount="$240.00"
            chain="solana"
          />
          <Toast
            className="absolute top-[58%] right-0 hidden sm:flex"
            title="Order paid"
            sub="Seoul · from NEAR"
            amount="$96.00"
            chain="near"
          />
          <p className="tabular absolute inset-x-0 bottom-0 text-center text-[13px] text-muted">
            <CountUp
              to={8}
              className="text-[56px] leading-none font-bold tracking-tight text-text"
            />{" "}
            chains ·{" "}
            <CountUp
              to={19}
              className="text-[56px] leading-none font-bold tracking-tight text-text"
            />{" "}
            payment routes
          </p>
        </div>
      </div>
    </section>
  );
}

/** Three products (the reference's "built for growth" row). */
export function Growth() {
  const cards = [
    {
      id: "invoices-b2b",
      title: "Sell To Businesses",
      body: "Invoices with lines, due dates and a receipt per payment, each with its explorer links.",
      art: <FauxInvoice className="scale-[0.82]" />,
    },
    {
      id: "checkout-b2c",
      title: "Sell To Consumers",
      body: "A prebuilt pay page that fits one screen: pick a token and a network, see the price, pay.",
      art: <FauxPay className="scale-[0.82]" />,
    },
    {
      id: "agents",
      title: "Let Agents Sell For You",
      body: "An MCP server: an AI agent issues invoices, opens checkouts and checks what was paid.",
      art: <FauxAgent className="scale-[0.82]" />,
    },
  ];
  return (
    <section className="mx-auto max-w-[1240px] px-4 py-24 sm:px-6">
      <p className="text-[14px] font-medium text-muted">Built for growth</p>
      <h2 className={`mt-2 break-words ${H2}`}>Take Your Business Onchain</h2>
      <p className={`mt-4 max-w-[56ch] ${BODY}`}>
        Three ways in, one account. Every one of them books the money on NEAR, where anyone can
        check it.
      </p>
      <div className="mt-10 grid gap-6 md:grid-cols-3">
        {cards.map((c, i) => (
          <Reveal key={c.id} delay={i * 120}>
            <article id={c.id} className="scroll-mt-24">
              <div className="grid h-[260px] place-items-center overflow-hidden rounded-[24px] bg-accent">
                {c.art}
              </div>
              <h3 className={`mt-6 ${H2_CARD}`}>{c.title}</h3>
              <p className={`mt-2 ${BODY}`}>{c.body}</p>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/** The accent band with the call to action. */
export function Band() {
  return (
    <section className="mx-auto max-w-[1240px] px-4 sm:px-6">
      <div className="relative isolate overflow-hidden rounded-[32px] bg-accent px-6 pt-16 text-center text-on-accent sm:px-10">
        <svg
          aria-hidden
          viewBox="0 0 200 80"
          className="absolute top-40 left-8 hidden w-40 text-white/70 md:block"
        >
          <path
            d="M2 60 C 40 10, 70 90, 100 40 S 160 0, 198 50"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
        <h2 className={`mx-auto max-w-[18ch] ${H2}`}>Stablecoin Payments For Growing Businesses</h2>
        <p className="mx-auto mt-5 max-w-[50ch] text-[18px] leading-7 font-normal text-white/85">
          Start with an invoice, add a store when you are ready. No card fees, no chargebacks, no
          custody: the money moves only as the contract allows.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link
            href="/app"
            className="inline-flex h-12 items-center gap-2 rounded-full bg-white px-6 text-[15px] font-medium text-accent"
          >
            Open the app <ArrowRight aria-hidden size={16} />
          </Link>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-12 items-center gap-2 rounded-full border border-white/40 px-6 text-[15px] font-medium"
          >
            Read the code
          </a>
        </div>
        <div className="relative mx-auto mt-12 flex h-[250px] max-w-[760px] items-end justify-center">
          <CoinCards className="translate-y-6" />
          <Toast
            className="absolute top-2 right-0 hidden text-text md:flex"
            title="Order #47 paid"
            sub="Shopify · from Polygon"
            amount="$112.00"
            chain="polygon"
          />
          <Toast
            className="absolute bottom-10 left-0 hidden text-text md:flex"
            title="Invoice paid"
            sub="from NEAR"
            amount="$74.50"
            chain="near"
          />
        </div>
      </div>
    </section>
  );
}

/** Real payments, checkable on the explorer (where the reference shows customer quotes). */
export function OnChain({ proof = PROOF_ROWS }: { proof?: readonly ProofRow[] }) {
  const rows = proof
    .filter((r) => r.type !== "Checkout opened" && r.type !== "Invoice issued")
    .slice(0, 10);
  const loop = [...rows, ...rows];
  const when = (t: number) =>
    new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(t * 1000),
    );
  return (
    <section className="py-24">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-end justify-between gap-4 px-4 sm:px-6">
        <h2 className={`break-words ${H2}`}>What The Chain Says</h2>
        <Link
          href="/proof"
          className="inline-flex items-center gap-1.5 text-[15px] font-medium text-accent-text hover:underline"
        >
          Every transaction <ArrowRight aria-hidden size={16} />
        </Link>
      </div>
      <div className="mt-10 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_8%,black_92%,transparent)]">
        <ul className="flex w-max gap-5 px-4 motion-safe:animate-[landing-marquee_60s_linear_infinite] hover:[animation-play-state:paused]">
          {loop.map((r, i) => (
            <li
              key={`${r.tx}-${i}`}
              className="w-[330px] shrink-0 rounded-[22px] border border-border bg-surface p-5"
            >
              <p className="tabular text-[36px] leading-[1.1] font-bold">${r.amount_usd}</p>
              <p className="mt-2 text-[15px] leading-6 text-muted">
                “{r.type}, booked by the contract on {when(r.time)}.”
              </p>
              <div className="mt-5 flex items-center gap-3">
                <BrandMark className="size-9" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[12px]">{r.tx}</p>
                  <a
                    href={nearTxUrl(r.tx)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent-text hover:underline"
                  >
                    View on NearBlocks <ExternalLink aria-hidden size={12} />
                  </a>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function LandingFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-[1240px] gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_repeat(4,1fr)]">
        <div>
          <Brand className="h-8 w-auto" />
          <p className="mt-4 max-w-[30ch] text-[14px] leading-6 text-muted">
            Stablecoin invoices and checkout, booked on NEAR.
          </p>
        </div>
        {MENUS.map((m) => (
          <div key={m.label}>
            <p className="text-[14px] font-medium text-muted">{m.label}</p>
            <ul className="mt-3 space-y-2">
              {m.items.map((it) => (
                <li key={it.label}>
                  <a
                    href={it.href}
                    {...(it.external ? { target: "_blank", rel: "noreferrer" } : {})}
                    className="text-[14px] hover:text-accent-text"
                  >
                    {it.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div>
          {/* The nav's two plain links, so the footer and the bar list the same pages. */}
          <p className="text-[14px] font-medium text-muted">More</p>
          <ul className="mt-3 space-y-2 text-[14px]">
            <li>
              <Link href="/how-it-works" className="hover:text-accent-text">
                How it works
              </Link>
            </li>
            <li>
              <Link href="/proof" className="hover:text-accent-text">
                Proof
              </Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="mx-auto flex max-w-[1240px] items-center justify-between border-t border-border px-4 py-6 text-[13px] text-muted sm:px-6">
        <span>© 2026 Openrail</span>
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="hover:text-text">
          GitHub
        </a>
      </div>
      {/* The name, large and quiet, then a rule and the contract every payment goes through. */}
      <div className="mx-auto max-w-[1240px] overflow-hidden px-4 pt-6 pb-10 sm:px-6">
        <p
          aria-hidden
          className="flex items-end justify-center leading-[0.8] font-extrabold tracking-[-0.04em] text-accent [font-variant-caps:all-small-caps] text-[clamp(72px,19vw,260px)] select-none"
        >
          openrail
          <span className="mb-[0.06em] ml-[0.04em] inline-block size-[0.14em] rounded-full bg-accent" />
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5 text-[13px] font-light text-muted">
          <p>
            Payments are booked by{" "}
            <a
              href={nearAccountUrl(PROOF_CONTRACT)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-text hover:text-accent-text"
            >
              {PROOF_CONTRACT}
            </a>{" "}
            on NEAR mainnet.
          </p>
          <p>MIT licensed</p>
        </div>
      </div>
    </footer>
  );
}
