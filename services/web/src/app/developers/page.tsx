import {
  ArrowUpRight,
  BookOpen,
  Boxes,
  Coins,
  FileText,
  KeyRound,
  Layers,
  ShieldCheck,
  Store,
  Terminal,
  Webhook,
  Bot,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { GitHubButton, LandingNav } from "@/components/landing/nav";
import { DOCS_URL, QUICKSTART_URL, REFERENCE_URL } from "@/components/landing/links";
import { LandingFooter } from "@/components/landing/sections";
import { Reveal } from "@/components/motion/reveal";
import { CodeBlock } from "@/components/ui/code-block";
import { cn } from "@/lib/cn";

export const metadata: Metadata = {
  title: "Developers: build on Openrail",
  description:
    "Quickstart, API reference and documentation for Openrail: create a checkout with one call, get a signed webhook when it is paid, read everything over a REST API.",
};

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.openrail.incepture.dev";
const H2 = "text-[clamp(28px,4vw,44px)] leading-[1.05] font-extrabold tracking-[-0.03em]";

const STEPS: { title: string; body: React.ReactNode; label: string; code: string }[] = [
  {
    title: "Get an API key",
    body: (
      <>
        Sign in with a NEAR wallet, open{" "}
        <Link href="/app/developers" className="text-accent-text hover:underline">
          API Integration
        </Link>{" "}
        and create a secret key. It is shown once; keep it on your server.
      </>
    ),
    label: "Shell",
    code: `export API=${API}\nexport OPENRAIL_SECRET_KEY=or_sk_live_...`,
  },
  {
    title: "Create a checkout",
    body: "One call per order. The amount is in US dollars; the same order_ref returns the same checkout, so retries are safe.",
    label: "curl",
    code: `curl -s -X POST "$API/v1/checkouts" \\
  -H "Authorization: Bearer $OPENRAIL_SECRET_KEY" \\
  -H "Idempotency-Key: order-1042" \\
  -H "content-type: application/json" \\
  -d '{"order_ref":"1042","amount_usd":"48.50","expires_in_minutes":30,
       "return_url":"https://shop.example/thanks"}'`,
  },
  {
    title: "Send the payer to pay_url",
    body: "The answer has a hosted pay page. The payer picks a coin and a chain, pays from a wallet or an exchange, and sees the price before paying.",
    label: "Response (201)",
    code: `{
  "id": "iamyoungjohn-near-32c2a59011df",
  "pay_url": "https://openrail.incepture.dev/c/iamyoungjohn-near-32c2a59011df",
  "claim_account": "iamyoungjohn-near-32c2a59011df.openrail.near",
  "status": "pending",
  "expires_at": "2026-11-14T19:30:00Z"
}`,
  },
  {
    title: "Hear when it is paid",
    body: (
      <>
        Add a webhook endpoint in API Integration. Each delivery is signed:{" "}
        <code className="font-mono text-[13px]">Openrail-Signature: t=…,v1=…</code>, an HMAC-SHA256
        of the timestamp, a dot and the raw body. Check it before you trust the event.
      </>
    ),
    label: "Node.js",
    code: `import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  return fresh && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}

// event.type === "checkout.paid" -> mark order data.order_ref as paid`,
  },
  {
    title: "Check it yourself",
    body: "Every payment is booked by the contract openrail.near. Read the checkout any time, or open the booking on the explorer.",
    label: "curl",
    code: `curl -s "$API/v1/checkouts/iamyoungjohn-near-32c2a59011df" \\
  -H "Authorization: Bearer $OPENRAIL_SECRET_KEY"`,
  },
];

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const GROUPS: { name: string; icon: typeof Webhook; rows: [Method, string, string][] }[] = [
  {
    name: "Checkouts",
    icon: Store,
    rows: [
      ["POST", "/v1/checkouts", "Open a hosted checkout for an order"],
      ["GET", "/v1/checkouts/{id}", "A checkout, its status and payments"],
      ["POST", "/v1/checkouts/{id}/accept_late", "Keep a payment that came after expiry"],
      ["POST", "/v1/checkouts/{id}/refund_quote", "Quote the refund of a late payment"],
    ],
  },
  {
    name: "Invoices",
    icon: FileText,
    rows: [
      ["POST", "/v1/invoices", "Create and issue an invoice"],
      ["GET", "/v1/invoices", "List your invoices"],
      ["GET", "/v1/invoices/{id}", "An invoice and its live onchain view"],
      ["GET", "/v1/invoices/{id}/pdf", "The invoice PDF"],
      ["POST", "/v1/recurring_invoices", "Bill on a schedule"],
    ],
  },
  {
    name: "Payments and events",
    icon: Coins,
    rows: [
      ["GET", "/v1/payments", "Payments booked to you"],
      ["GET", "/v1/events", "Indexed events, newest first"],
      ["GET", "/v1/routes", "Chains and coins that can pay right now"],
      ["GET", "/v1/analytics", "Revenue and activity, from the bookings"],
    ],
  },
  {
    name: "Webhooks",
    icon: Webhook,
    rows: [
      ["POST", "/v1/webhook_endpoints", "Register an endpoint"],
      ["POST", "/v1/webhook_endpoints/{id}/test", "Send a signed test event"],
      ["GET", "/v1/webhook_endpoints/{id}/deliveries", "The delivery log"],
      ["GET", "/v1/webhook_event_types", "Event types you can subscribe to"],
    ],
  },
  {
    name: "Receipts and statements",
    icon: ShieldCheck,
    rows: [
      ["GET", "/v1/receipts/{booking_tx}.json", "Canonical receipt (public)"],
      ["GET", "/v1/receipts/{booking_tx}.pdf", "Receipt PDF (public)"],
      ["GET", "/v1/statements", "A statement for any period, CSV or PDF"],
    ],
  },
  {
    name: "Keys and business",
    icon: KeyRound,
    rows: [
      ["POST", "/v1/api_keys", "Create a key (secret shown once)"],
      ["POST", "/v1/api_keys/{id}/rotate", "Rotate a key"],
      ["GET", "/v1/business", "Your business profile"],
      ["POST", "/v1/cashout/quote", "Quote a cash-out to another chain"],
    ],
  },
];

const METHOD_TONE: Record<Method, string> = {
  GET: "bg-success/12 text-success-text",
  POST: "bg-accent-soft text-accent-text",
  PUT: "bg-[color-mix(in_oklab,#f59e0b_16%,transparent)] text-[#b45309] dark:text-[#fbbf24]",
  PATCH: "bg-[color-mix(in_oklab,#f59e0b_16%,transparent)] text-[#b45309] dark:text-[#fbbf24]",
  DELETE: "bg-danger/12 text-danger-text",
};

const DOC = (slug: string) => `/docs/${slug}`;
const DOCS: { title: string; body: string; href: string; icon: typeof Webhook }[] = [
  {
    title: "Architecture",
    body: "The contract, the per-invoice account and the services around them.",
    href: DOC("architecture"),
    icon: Layers,
  },
  {
    title: "Trust model",
    body: "What you trust, what you do not, and how each risk is handled.",
    href: DOC("trust"),
    icon: ShieldCheck,
  },
  {
    title: "API contract",
    body: "Auth, idempotency, error codes and every core route.",
    href: DOC("api"),
    icon: Terminal,
  },
  {
    title: "Fees and line items",
    body: "The 0.25% fee, who pays it, and how amounts are kept exact.",
    href: DOC("fees"),
    icon: Coins,
  },
  {
    title: "Checkout",
    body: "Hosted checkouts, late payments, refunds and payment links.",
    href: DOC("checkout"),
    icon: Store,
  },
  {
    title: "Shopify",
    body: "The Shopify app: install, settings and the order flow.",
    href: DOC("shopify"),
    icon: Boxes,
  },
  {
    title: "Cash out",
    body: "Quotes, statuses and where the money is at each step.",
    href: DOC("cash-out"),
    icon: ArrowUpRight,
  },
  {
    title: "Agent MCP",
    body: "Tools for your AI agent; it prepares, you sign.",
    href: "/agents",
    icon: Bot,
  },
  {
    title: "Limitations",
    body: "What this build does not do yet, stated plainly.",
    href: DOC("limitations"),
    icon: BookOpen,
  },
];

/** The public overview for developers: Quickstart, API reference, Documentation (each links to its full page). */
export default function DevelopersPage() {
  return (
    <div className="min-h-dvh bg-bg text-text">
      <LandingNav extra={<GitHubButton />} />
      <main>
        <section className="mx-auto grid max-w-[1240px] items-center gap-10 px-4 pt-12 pb-10 sm:px-6 lg:grid-cols-[1fr_1.05fr]">
          <div>
            <Reveal>
              <p className="text-[14px] font-semibold text-accent-text">Developers</p>
              <h1 className="mt-2 text-[clamp(38px,5vw,64px)] leading-[1.02] font-extrabold tracking-[-0.03em]">
                Integrate Stablecoin Payments Seamlessly
              </h1>
            </Reveal>
            <Reveal delay={100}>
              <p className="mt-5 max-w-[52ch] text-[17px] leading-7 text-muted">
                Create a checkout or an invoice, send the payer a link, and get a signed webhook
                when it is paid from any of eight chains. Every payment is booked onchain by{" "}
                <span className="font-mono text-[15px]">openrail.near</span>, so you can check it
                yourself.
              </p>
            </Reveal>
            <Reveal delay={180}>
              <nav aria-label="On this page" className="mt-8 flex flex-wrap gap-2.5">
                {[
                  ["Quickstart", "#quickstart"],
                  ["API reference", "#reference"],
                  ["Documentation", "#documentation"],
                ].map(([label, href], i) => (
                  <a
                    key={href}
                    href={href}
                    className={cn(
                      "inline-flex h-11 items-center rounded-full px-5 text-[14px] font-semibold",
                      i === 0
                        ? "bg-accent text-on-accent hover:bg-accent-hover"
                        : "border border-border bg-surface hover:bg-surface-2",
                    )}
                  >
                    {label}
                  </a>
                ))}
              </nav>
            </Reveal>
          </div>
          <Reveal delay={120} from="right">
            <div className="overflow-hidden rounded-[22px] border border-border bg-surface shadow-[0_30px_80px_-40px_color-mix(in_oklab,var(--accent)_60%,transparent)]">
              <div className="flex items-center gap-1.5 border-b border-border px-4 py-3">
                <span className="size-2.5 rounded-full bg-[#ff5f57]" />
                <span className="size-2.5 rounded-full bg-[#febc2e]" />
                <span className="size-2.5 rounded-full bg-[#28c840]" />
                <span className="ml-3 font-mono text-[12px] text-muted">POST /v1/checkouts</span>
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-6">
                <code>
                  <span className="text-muted">$ </span>curl -X POST $API/v1/checkouts \{"\n"}
                  {"    "}-H{" "}
                  <span className="text-accent-text">
                    &quot;Authorization: Bearer or_sk_live_…&quot;
                  </span>{" "}
                  \{"\n"}
                  {"    "}-d{" "}
                  <span className="text-accent-text">
                    &apos;{"{"}
                    &quot;order_ref&quot;:&quot;1042&quot;,&quot;amount_usd&quot;:&quot;48.50&quot;
                    {"}"}&apos;
                  </span>
                  {"\n\n"}
                  <span className="text-success-text">201 Created</span>
                  {"\n"}
                  {"{"}
                  {"\n"}
                  {"  "}&quot;pay_url&quot;:{" "}
                  <span className="text-accent-text">&quot;…/c/iamyoungjohn-near-32c2…&quot;</span>,
                  {"\n"}
                  {"  "}&quot;status&quot;:{" "}
                  <span className="text-accent-text">&quot;pending&quot;</span>
                  {"\n"}
                  {"}"}
                  {"\n\n"}
                  <span className="text-muted"># a minute later, at your webhook:</span>
                  {"\n"}
                  {"{"} &quot;type&quot;:{" "}
                  <span className="text-success-text">&quot;checkout.paid&quot;</span>,
                  &quot;data&quot;: {"{"} &quot;order_ref&quot;: &quot;1042&quot; {"}"} {"}"}
                </code>
              </pre>
            </div>
          </Reveal>
        </section>

        <section
          id="quickstart"
          aria-labelledby="qs"
          className="mx-auto max-w-[1240px] scroll-mt-28 px-4 py-16 sm:px-6"
        >
          <Reveal>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-[14px] font-semibold text-accent-text">Quickstart</p>
                <h2 id="qs" className={`mt-2 ${H2}`}>
                  Your First Paid Checkout
                </h2>
              </div>
              <a
                href={QUICKSTART_URL}
                className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-accent-text hover:underline"
              >
                Full quickstart <ArrowUpRight aria-hidden size={16} />
              </a>
            </div>
          </Reveal>
          <ol className="mt-10 space-y-5">
            {STEPS.map((s, i) => (
              <Reveal key={s.title} delay={60}>
                <li className="grid gap-5 rounded-[22px] border border-border bg-surface p-5 sm:p-7 lg:grid-cols-[0.85fr_1.15fr] lg:gap-10">
                  <div className="flex gap-4">
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-[15px] font-bold text-on-accent">
                      {i + 1}
                    </span>
                    <div>
                      <h3 className="text-[19px] leading-7 font-semibold">{s.title}</h3>
                      <p className="mt-2 text-[15px] leading-6 text-muted">{s.body}</p>
                    </div>
                  </div>
                  <CodeBlock label={s.label} code={s.code} className="min-w-0" />
                </li>
              </Reveal>
            ))}
          </ol>
        </section>

        <section
          id="reference"
          aria-labelledby="ref"
          className="mx-auto max-w-[1240px] scroll-mt-28 px-4 py-16 sm:px-6"
        >
          <Reveal>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-[14px] font-semibold text-accent-text">API reference</p>
                <h2 id="ref" className={`mt-2 ${H2}`}>
                  A Plain REST API
                </h2>
              </div>
              <a
                href={REFERENCE_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-accent-text hover:underline"
              >
                Full reference (OpenAPI 3.1) <ArrowUpRight aria-hidden size={16} />
              </a>
            </div>
          </Reveal>
          <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[
              ["Base URL", API],
              ["Auth", "Authorization: Bearer or_sk_live_…"],
              ["Retries", "Idempotency-Key on any POST: same key and body, same answer"],
              ["Errors", '{"error": {"code", "message"}}: the code is stable'],
            ].map(([k, v], i) => (
              <Reveal key={k} delay={i * 60}>
                <div className="h-full rounded-2xl border border-border bg-surface p-4">
                  <p className="caption">{k}</p>
                  <p className="mt-1 font-mono text-[13px] leading-5 break-words">{v}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {GROUPS.map((g, gi) => (
              <Reveal key={g.name} delay={(gi % 2) * 80}>
                <div className="h-full overflow-hidden rounded-[22px] border border-border bg-surface">
                  <p className="flex items-center gap-2 border-b border-border px-5 py-3.5 text-[15px] font-semibold">
                    <g.icon aria-hidden size={17} className="text-accent-text" /> {g.name}
                  </p>
                  <ul>
                    {g.rows.map(([m, path, what]) => (
                      <li
                        key={m + path}
                        className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 border-b border-border px-5 py-3 last:border-0 sm:grid-cols-[64px_minmax(0,1.1fr)_minmax(0,1fr)]"
                      >
                        <span
                          className={cn(
                            "mt-0.5 w-fit rounded-md px-1.5 py-0.5 font-mono text-[11px] font-bold",
                            METHOD_TONE[m],
                          )}
                        >
                          {m}
                        </span>
                        <code className="font-mono text-[13px] leading-6 break-all">{path}</code>
                        <span className="col-start-2 text-[13.5px] leading-6 text-muted sm:col-start-3">
                          {what}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        <section
          id="documentation"
          aria-labelledby="docs"
          className="mx-auto max-w-[1240px] scroll-mt-28 px-4 pt-16 pb-24 sm:px-6"
        >
          <Reveal>
            <p className="text-[14px] font-semibold text-accent-text">Documentation</p>
            <h2 id="docs" className={`mt-2 ${H2}`}>
              Go Deeper
            </h2>
            <p className="mt-4 max-w-[60ch] text-[16px] leading-7 text-muted">
              How it is built, what you trust, and each part on its own page.
            </p>
          </Reveal>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {DOCS.map((d, i) => {
              const external = d.href.startsWith("http");
              return (
                <Reveal key={d.title} delay={(i % 3) * 70}>
                  <a
                    href={d.href}
                    {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                    className="group flex h-full flex-col rounded-[22px] border border-border bg-surface p-5 transition-colors hover:border-accent"
                  >
                    <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent-text">
                      <d.icon aria-hidden size={18} />
                    </span>
                    <span className="mt-4 flex items-center gap-1.5 text-[17px] font-semibold">
                      {d.title}
                      <ArrowUpRight
                        aria-hidden
                        size={15}
                        className="text-muted transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                      />
                    </span>
                    <span className="mt-1.5 text-[14.5px] leading-6 text-muted">{d.body}</span>
                  </a>
                </Reveal>
              );
            })}
          </div>
          <Reveal className="mt-10 flex justify-center">
            <a
              href={DOCS_URL}
              className="group inline-flex h-14 items-center gap-3 rounded-full bg-accent py-2 pr-2 pl-6 text-[15px] font-medium text-on-accent hover:bg-accent-hover"
            >
              Read the docs
              <span className="grid size-10 place-items-center rounded-full bg-on-accent text-accent transition-transform group-hover:rotate-45">
                <ArrowUpRight aria-hidden size={18} />
              </span>
            </a>
          </Reveal>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
