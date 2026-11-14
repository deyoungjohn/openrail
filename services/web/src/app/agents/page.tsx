import { Bot, CheckCircle2, FileSearch, KeyRound, Link2, Receipt, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { FEATURE_MOCKS } from "@/components/landing/feature-mocks";
import { REPO_URL } from "@/components/landing/links";
import { LandingNav } from "@/components/landing/nav";
import { Reveal } from "@/components/motion/reveal";
import { CodeBlock } from "@/components/ui/code-block";
import { LandingFooter } from "@/components/landing/sections";

export const metadata: Metadata = {
  title: "Agent MCP: Openrail for AI agents",
  description:
    "An MCP server that lets an AI agent list invoices, check what was paid, fetch receipts, quote pay links and prepare invoices. It holds no keys and never signs: you approve in your wallet.",
};

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://openrail.incepture.dev";

const TOOLS = [
  {
    icon: FileSearch,
    name: "list_claims",
    body: "Lists your invoices and checkouts, filtered by status: open, partly paid, paid or closed.",
  },
  {
    icon: CheckCircle2,
    name: "claim_status",
    body: "What one invoice is owed, what has been booked on NEAR, and whether it is settled.",
  },
  {
    icon: Receipt,
    name: "receipt",
    body: "The receipt of a payment, with its explorer links and the proof it was booked.",
  },
  {
    icon: Link2,
    name: "quote_pay_link",
    body: "The pay link to send a client and the amount due, or a live price for a chosen coin and chain.",
  },
  {
    icon: KeyRound,
    name: "prepare_invoice",
    body: "Prepares a new invoice as an unsigned transaction and a link: you review it and sign in your wallet.",
  },
];

const SAFETY = [
  "No keys. A config with a private key, seed phrase or signer is refused at start.",
  "Never signs, never sends. Anything that moves value comes back as an unsigned transaction and an approval link, marked human_signature_required.",
  "Same rules as the API: it reads the public API with your API key and gets no special access.",
  "Gentle on the network: reads are cached for 30 seconds and calls are limited to 60 a minute, so an agent loop cannot flood anything.",
];

const CONFIG = `{
  "mcpServers": {
    "openrail": {
      "command": "node",
      "args": ["<path to openrail>/services/mcp/bin/openrail-mcp.mjs"],
      "env": {
        "OPENRAIL_API_URL": "${API}",
        "OPENRAIL_API_KEY": "<an API key from API Integration>"
      }
    }
  }
}`;

/** Things to ask an agent once it is connected, and the tool call each one becomes. */
const SAMPLES: { ask: string; tool: string }[] = [
  {
    ask: "Which of my invoices are still open?",
    tool: `list_claims {"status": "Open", "limit": 20}`,
  },
  {
    ask: "Has c-12 been paid yet? How much is still owed?",
    tool: `claim_status {"tokenId": "c-12"}`,
  },
  {
    ask: "Get me the receipt and the on-chain proof for c-12.",
    tool: `receipt {"tokenId": "c-12"}`,
  },
  {
    ask: "Send Spectra Inc the pay link for the $386.50 they owe on c-14.",
    tool: `quote_pay_link {"tokenId": "c-14", "amountUsd": "386.50"}`,
  },
  {
    ask: "Bill northwind.near $250 for the December retainer, due December 1.",
    tool: `prepare_invoice {"debtor": "northwind.near", "amountDue": "250000000", "dueDate": 1796083200}`,
  },
];

/** The Agent MCP: what an agent can do with Openrail, and what it can never do. */
export default function AgentsPage() {
  const Session = FEATURE_MOCKS.agents;
  return (
    <div className="min-h-dvh bg-bg text-text">
      <LandingNav />
      <main>
        <section className="mx-auto grid max-w-[1240px] items-center gap-10 px-4 pt-10 pb-16 sm:px-6 lg:grid-cols-[1fr_1fr]">
          <div>
            <Reveal>
              <p className="inline-flex items-center gap-2 rounded-full border border-border bg-surface p-1 pr-3 text-[13px] font-medium">
                <span className="rounded-full bg-accent px-2.5 py-1 text-on-accent">Agent MCP</span>
                <span className="text-accent-text">Model Context Protocol server</span>
              </p>
            </Reveal>
            <Reveal delay={80}>
              <h1 className="mt-6 text-[clamp(36px,5vw,60px)] leading-[1.03] font-bold tracking-[-0.03em]">
                Let Your Agent Run The Books. <span className="text-accent">You Sign.</span>
              </h1>
            </Reveal>
            <Reveal delay={160}>
              <p className="mt-6 max-w-[52ch] text-[18px] leading-7 text-muted">
                Connect Claude, or any agent that speaks MCP, to Openrail. It checks what was paid,
                fetches receipts, sends pay links and prepares invoices. It holds no keys: every
                invoice it prepares waits for your signature.
              </p>
            </Reveal>
            <Reveal delay={240}>
              <div className="mt-8 flex flex-wrap gap-3">
                <a
                  href="#setup"
                  className="inline-flex h-14 items-center rounded-full bg-accent px-6 text-[15px] font-semibold text-on-accent hover:bg-accent-hover"
                >
                  Set it up
                </a>
                <a
                  href={`${REPO_URL}/tree/main/services/mcp`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-14 items-center rounded-full border border-border bg-surface px-6 text-[15px] font-medium hover:bg-surface-2"
                >
                  Read the code
                </a>
              </div>
            </Reveal>
          </div>
          <Reveal delay={120}>
            <div className="rounded-[28px] bg-[color-mix(in_oklab,var(--accent)_12%,var(--surface))] p-5 sm:p-8">
              {Session ? <Session /> : null}
            </div>
          </Reveal>
        </section>

        <section aria-labelledby="tools" className="mx-auto max-w-[1240px] px-4 py-16 sm:px-6">
          <Reveal>
            <h2
              id="tools"
              className="text-[clamp(28px,4vw,44px)] leading-[1.05] font-extrabold tracking-[-0.03em]"
            >
              Five Tools, One Rule
            </h2>
            <p className="mt-4 max-w-[60ch] text-[16px] leading-7 text-muted">
              The agent reads and prepares. You approve anything that moves money.
            </p>
          </Reveal>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {TOOLS.map((t, i) => (
              <Reveal key={t.name} delay={(i % 3) * 80}>
                <article className="h-full rounded-[22px] border border-border bg-surface p-6">
                  <span className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent-text">
                    <t.icon aria-hidden size={20} />
                  </span>
                  <h3 className="mt-5 font-mono text-[16px] font-semibold">{t.name}</h3>
                  <p className="mt-2 text-[15px] leading-6 text-muted">{t.body}</p>
                </article>
              </Reveal>
            ))}
            <Reveal delay={160}>
              <article className="flex h-full flex-col justify-center rounded-[22px] border border-dashed border-border p-6">
                <Bot aria-hidden size={22} className="text-accent-text" />
                <p className="mt-3 text-[15px] leading-6 text-muted">
                  Each enabled module can add its own tool. A module that is switched off adds
                  nothing.
                </p>
              </article>
            </Reveal>
          </div>
        </section>

        <section aria-labelledby="safety" className="mx-auto max-w-[1240px] px-4 py-16 sm:px-6">
          <div className="grid gap-10 rounded-[28px] border border-border bg-surface p-6 sm:p-10 lg:grid-cols-[0.8fr_1.2fr]">
            <Reveal>
              <ShieldCheck aria-hidden size={28} className="text-accent" />
              <h2
                id="safety"
                className="mt-4 text-[clamp(26px,3.2vw,38px)] leading-[1.08] font-extrabold tracking-[-0.03em]"
              >
                It Can Never Move Your Money
              </h2>
            </Reveal>
            <ul className="space-y-4">
              {SAFETY.map((s, i) => (
                <Reveal key={s} delay={i * 60}>
                  <li className="flex gap-3 text-[16px] leading-7 text-muted">
                    <CheckCircle2 aria-hidden size={20} className="mt-1 shrink-0 text-accent" />
                    <span>{s}</span>
                  </li>
                </Reveal>
              ))}
            </ul>
          </div>
        </section>

        <section
          id="setup"
          aria-labelledby="setup-title"
          className="mx-auto max-w-[1240px] scroll-mt-28 px-4 pt-16 pb-12 sm:px-6"
        >
          <Reveal>
            <h2
              id="setup-title"
              className="text-[clamp(28px,4vw,44px)] leading-[1.05] font-extrabold tracking-[-0.03em]"
            >
              Set It Up In Three Steps
            </h2>
          </Reveal>
          <ol className="mt-8 grid gap-4 lg:grid-cols-3">
            {[
              [
                "Create an API key",
                <>
                  In the app, open{" "}
                  <Link href="/app/developers" className="text-accent-text hover:underline">
                    API Integration
                  </Link>{" "}
                  and create a key. It is shown once.
                </>,
              ],
              [
                "Get the server",
                <>
                  Clone{" "}
                  <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent-text hover:underline"
                  >
                    the repository
                  </a>{" "}
                  and run <code className="font-mono text-[14px]">pnpm install</code>. Try it with
                  no key first:{" "}
                  <code className="font-mono text-[14px]">
                    node services/mcp/bin/openrail-mcp.mjs --fake
                  </code>
                  .
                </>,
              ],
              [
                "Add it to your agent",
                <>
                  Put the block below in your MCP client's config (Claude Desktop, Claude Code or
                  any other) and restart it.
                </>,
              ],
            ].map(([title, body], i) => (
              <Reveal key={String(title)} delay={i * 80}>
                <li className="h-full rounded-[22px] border border-border bg-surface p-6">
                  <p className="text-[13px] font-semibold text-accent-text">
                    {String(i + 1).padStart(2, "0")}
                  </p>
                  <h3 className="mt-2 text-[18px] font-semibold">{title}</h3>
                  <p className="mt-2 text-[15px] leading-6 text-muted">{body}</p>
                </li>
              </Reveal>
            ))}
          </ol>
          <Reveal className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <CodeBlock
                label="Get the server"
                code={`git clone ${REPO_URL}.git\ncd openrail\npnpm install`}
              />
              <CodeBlock
                label="Try it with no key (sample data)"
                code="node services/mcp/bin/openrail-mcp.mjs --fake"
              />
            </div>
            <CodeBlock label="MCP client config (JSON)" code={CONFIG} />
          </Reveal>
        </section>

        <section aria-labelledby="samples" className="mx-auto max-w-[1240px] px-4 pb-24 sm:px-6">
          <Reveal>
            <h2
              id="samples"
              className="text-[clamp(28px,4vw,44px)] leading-[1.05] font-extrabold tracking-[-0.03em]"
            >
              Things To Ask Your Agent
            </h2>
            <p className="mt-4 max-w-[60ch] text-[16px] leading-7 text-muted">
              Say it in plain words. Under each one is the tool call your agent makes, if you want
              to run it yourself.
            </p>
          </Reveal>
          <ol className="mt-8 grid gap-4 lg:grid-cols-2">
            {SAMPLES.map((x, i) => (
              <Reveal key={x.ask} delay={(i % 2) * 80}>
                <li className="h-full rounded-[22px] border border-border bg-surface p-5">
                  <p className="text-[16px] leading-7 font-medium">&ldquo;{x.ask}&rdquo;</p>
                  <CodeBlock className="mt-3" label="Tool call" code={x.tool} />
                </li>
              </Reveal>
            ))}
          </ol>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
