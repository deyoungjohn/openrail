/** The docs' sidebar, in reading order. Each slug is a file in `content/docs/<slug>.md`. */
export interface DocLink {
  slug: string;
  title: string;
}

export const DOCS_NAV: { group: string; items: DocLink[] }[] = [
  {
    group: "Getting started",
    items: [
      { slug: "introduction", title: "Introduction" },
      { slug: "quickstart", title: "Quickstart" },
      { slug: "live", title: "Live deployment" },
    ],
  },
  {
    group: "Concepts",
    items: [
      { slug: "how-a-payment-works", title: "How a payment works" },
      { slug: "invoice-accounts", title: "One account per invoice" },
      { slug: "settlement", title: "Settlement and payouts" },
      { slug: "confidential-balance", title: "Confidential balance" },
      { slug: "fees", title: "Fees and storage" },
      { slug: "receipts", title: "Receipts and statements" },
      { slug: "verify", title: "Verify a payment" },
    ],
  },
  {
    group: "Guides",
    items: [
      { slug: "invoices", title: "Send an invoice" },
      { slug: "checkout", title: "Hosted checkout" },
      { slug: "webhooks", title: "Webhooks" },
      { slug: "shopify", title: "Shopify" },
      { slug: "woocommerce", title: "WooCommerce" },
      { slug: "cash-out", title: "Cash out" },
      { slug: "agents", title: "AI agents (MCP)" },
      { slug: "cli-sdk", title: "CLI and SDK" },
    ],
  },
  {
    group: "API reference",
    items: [
      { slug: "api", title: "Authentication and errors" },
      { slug: "endpoints", title: "Endpoints" },
      { slug: "events", title: "Event types" },
    ],
  },
  {
    group: "Architecture",
    items: [
      { slug: "architecture", title: "Overview" },
      { slug: "contract", title: "The contract" },
      { slug: "services", title: "Services" },
      { slug: "modules", title: "Modules" },
    ],
  },
  {
    group: "Trust and limits",
    items: [
      { slug: "trust", title: "Trust model" },
      { slug: "security", title: "Security" },
      { slug: "limitations", title: "Limitations" },
    ],
  },
  {
    group: "Project",
    items: [
      { slug: "repository", title: "Repository map" },
      { slug: "run-locally", title: "Run locally" },
      { slug: "testing", title: "Tests and evidence" },
      { slug: "faq", title: "FAQ" },
    ],
  },
];

export const DOC_ORDER: DocLink[] = DOCS_NAV.flatMap((g) => g.items);
export const docHref = (slug: string, anchor?: string) =>
  `${slug === "introduction" ? "/docs" : `/docs/${slug}`}${anchor ? `#${anchor}` : ""}`;
