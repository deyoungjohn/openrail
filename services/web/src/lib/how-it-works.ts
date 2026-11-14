/**
 * How Openrail works, in plain words: a short version of the docs that anyone can follow. One source for the page
 * (`/how-it-works`) and its Markdown twin (`/how-it-works.md`) that agents and language models read.
 */
const REPO = "https://github.com/deyoungjohn/openrail";
const DOC = (path: string) => `${REPO}/blob/main/docs/src/${path}`;

export interface Step {
  id: string;
  title: string;
  body: string[];
  /** The full page in the docs for this step. */
  more: { label: string; href: string };
}

export const INTRO =
  "Openrail lets a business get paid in stablecoins. You send an invoice or open a checkout; your client pays from the chain their money is on; a contract on NEAR books the payment where anyone can check it; and the money reaches you as USDC on the chain you choose.";

export const STEPS: Step[] = [
  {
    id: "create",
    title: "1. You ask to be paid",
    body: [
      "Sign in with a NEAR wallet. Create an invoice (client, line items, due date) or, from a store, open a checkout for an order with one API call.",
      "Each invoice or checkout gets its own account on NEAR, created by the Openrail contract (openrail.near). The account has no keys, so nobody can spend from it; only the contract's rules move what lands there.",
      "You get a pay link to send. Shopify and WooCommerce stores show it at checkout for you.",
    ],
    more: { label: "Architecture: the per-invoice account", href: DOC("core/ARCHITECTURE.md") },
  },
  {
    id: "pay",
    title: "2. Your client pays from any chain",
    body: [
      "On the pay page the client picks a coin and a chain: USDC or USDT on NEAR, Base, Arbitrum, Ethereum, Solana, Polygon, Optimism or BNB Chain, or ETH, SOL and NEAR.",
      "They pay from a connected wallet, or send from an exchange to a one-time deposit address. NEAR Intents swaps it to USDC on the way, and the price is shown before they pay.",
      "A payment can be split over several chains, and a partial payment is kept until the rest arrives.",
    ],
    more: { label: "Checkout: the hosted pay page", href: DOC("modules/checkout/README.md") },
  },
  {
    id: "book",
    title: "3. The contract books it on NEAR",
    body: [
      "When the money lands in the invoice's account, the contract books it: the invoice is paid, the 0.25% fee is taken, and an event is written on NEAR mainnet. On mainnet the median booking took about 30 seconds.",
      "A watcher service asks the contract to book as soon as it sees the money, but anyone can call the same function, so a booking never depends on Openrail being up.",
      "A payment that arrives after an invoice is closed is refunded to the payer.",
    ],
    more: { label: "Trust model: what you rely on", href: DOC("core/TRUST.md") },
  },
  {
    id: "receive",
    title: "4. The money reaches you",
    body: [
      "Your share is held under your own account on NEAR Intents, never by Openrail, then sent on your schedule: after each payment, daily, weekly or monthly.",
      "Choose where it goes: USDC on the chain you pick, or your confidential balance on NEAR Intents, which only you can see.",
      "Cash out or withdraw any time to an address on any supported chain, in one signature.",
    ],
    more: { label: "Cash out: quotes and statuses", href: DOC("core/cashout.md") },
  },
  {
    id: "records",
    title: "5. The records keep themselves",
    body: [
      "Every payment gets a receipt page and a PDF with its explorer links and the fingerprint (a hash) of the terms both sides saw.",
      "Download a statement for any period; its fingerprint proves the file was not changed.",
      "The dashboard shows revenue, activity, top clients and the chains they paid from, all read from the bookings onchain.",
    ],
    more: { label: "Fees, line items and receipts", href: DOC("core/fees.md") },
  },
  {
    id: "connect",
    title: "6. Your systems and agents stay in step",
    body: [
      "The REST API (OpenAPI 3.1) does everything the app does, with API keys you create and revoke.",
      "Signed webhooks tell your store or backend when an invoice is paid, partly paid, late or closed.",
      "An MCP server lets an AI agent check payments, fetch receipts, send pay links and prepare invoices; it holds no keys, and you sign.",
    ],
    more: { label: "Developers: quickstart and API", href: "/developers" },
  },
];

export const CHECK = [
  "Every booking is a transaction of openrail.near on NEAR mainnet. The Proof page (/proof, or /proof.json) lists those of Belmonte Apparels, the developer's own demo business, with explorer links, updated every minute.",
  "Each receipt links to the payment on its own chain and to the booking on NEAR.",
  "The code is open source, and the docs say plainly what this build does not do yet (see Limitations).",
];

export const LINKS: [string, string][] = [
  ["Proof (recent transactions on NEAR)", "/proof"],
  ["Proof as JSON", "/proof.json"],
  ["Use cases: Shopify and WooCommerce", "/use-cases"],
  ["Developers: quickstart and API", "/developers"],
  ["Agent MCP", "/agents"],
  ["Features", "/features"],
  ["Documentation", "https://github.com/deyoungjohn/openrail/tree/main/docs"],
  [
    "API reference (OpenAPI)",
    "https://github.com/deyoungjohn/openrail/blob/main/services/api/openapi.json",
  ],
  ["Limitations", "https://github.com/deyoungjohn/openrail/blob/main/docs/src/core/LIMITATIONS.md"],
  ["llms.txt", "/llms.txt"],
];

/** The same content as Markdown, for agents. */
export function howItWorksMarkdown(): string {
  const out = ["# How Openrail works", "", INTRO, ""];
  for (const s of STEPS) {
    out.push(`## ${s.title}`, "");
    for (const b of s.body) out.push(`- ${b}`);
    out.push("", `More: [${s.more.label}](${s.more.href})`, "");
  }
  out.push("## How to check it", "");
  for (const c of CHECK) out.push(`- ${c}`);
  out.push("", "## Links", "");
  for (const [label, href] of LINKS) out.push(`- [${label}](${href})`);
  return `${out.join("\n")}\n`;
}
