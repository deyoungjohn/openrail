/** Where the landing page's menus lead. One place, so the nav and the footer never disagree. */

const REPO = "https://github.com/deyoungjohn/openrail";
const API = process.env.NEXT_PUBLIC_API_URL ?? "";

/** The full pages the Developers menu and the /developers overview point to. /docs leads to the documentation. */
export const QUICKSTART_URL = `${REPO}/blob/main/docs/src/modules/checkout/README.md`;
export const REFERENCE_URL =
  API === "" ? `${REPO}/blob/main/services/api/openapi.json` : `${API}/v1/openapi.json`;
export const DOCS_URL = "/docs";

export interface MenuItem {
  label: string;
  href: string;
  note: string;
  external?: boolean;
}

export const MENUS: {
  label: string;
  items: MenuItem[];
  overview?: { label: string; href: string };
}[] = [
  {
    label: "Features",
    items: [
      {
        label: "All features",
        href: "/features",
        note: "Everything Openrail does, screen by screen",
      },
      {
        label: "Invoices",
        href: "/features#invoices",
        note: "Bill a client; they pay from any chain",
      },
      {
        label: "Checkout",
        href: "/features#checkout",
        note: "A hosted stablecoin checkout for stores",
      },
      {
        label: "Confidential payouts",
        href: "/features#confidential",
        note: "A balance only you can see",
      },
      {
        label: "Agent MCP",
        href: "/agents",
        note: "Let an AI agent issue and track payments",
      },
    ],
  },
  {
    label: "Use cases",
    items: [
      {
        label: "Shopify",
        href: "/use-cases#shopify",
        note: "The Shopify app, proven on a real store",
      },
      {
        label: "WooCommerce",
        href: "/use-cases#woocommerce",
        note: "The WordPress plugin, proven on a real store",
      },
    ],
  },
  {
    label: "Developers",
    items: [
      { label: "Overview", href: "/developers", note: "Quickstart, API and docs on one page" },
      {
        label: "API reference",
        href: REFERENCE_URL,
        note: "OpenAPI 3.1, every route",
        external: true,
      },
      { label: "Documentation", href: DOCS_URL, note: "How it is built, part by part" },
      { label: "GitHub", href: REPO, note: "Open source", external: true },
      { label: "llms.txt", href: "/llms.txt", note: "Openrail for language models" },
    ],
  },
];

export const REPO_URL = REPO;
