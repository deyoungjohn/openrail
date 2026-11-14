/**
 * The features, once: the landing page's cards and the Features page's sections read this list, so every card points
 * at the section that covers it (`/features#<id>`).
 */
export interface Feature {
  id: string;
  title: string;
  /** One or two sentences under the title on the Features page. */
  subtitle: string;
  /** The short line on the landing page's card (only for the features shown there). */
  card?: string;
  /** A page of its own, when the feature has one: cards and links go there instead of the section. */
  href?: string;
}

export const FEATURES: Feature[] = [
  {
    id: "dashboards",
    title: "Dashboards And Analytics",
    subtitle:
      "Revenue by month, activity by day, top clients and the chains they pay from, all read from the payments booked on chain.",
    card: "Revenue, activity, top clients and chains, from the payments booked on chain.",
  },
  {
    id: "stores",
    title: "Store Integrations",
    subtitle:
      "A Shopify app and a WooCommerce plugin put stablecoins at checkout. Any other store or app does the same with one API call.",
    card: "A Shopify app and a WooCommerce plugin; any other store with one API call.",
  },
  {
    id: "confidential",
    title: "Confidential Payouts",
    subtitle:
      "Turn on the confidential balance and payments move into NEAR Intents' confidential balance, which only you can see. Withdraw from it to any supported chain.",
    card: "Move payments to a confidential balance on NEAR Intents and withdraw to any chain.",
  },
  {
    id: "statements",
    title: "Statements",
    subtitle:
      "Download a statement for any period, every payment listed. Its fingerprint proves the file was not edited after it was made.",
    card: "Download a statement for any period; its fingerprint proves the file was not edited.",
  },
  {
    id: "api",
    title: "API And Webhooks",
    subtitle:
      "An OpenAPI 3.1 API with keys you create and revoke, and signed webhooks for every invoice and checkout event, with a delivery log and test events.",
    card: "OpenAPI, API keys and signed webhooks for every invoice and checkout event.",
  },
  {
    id: "cash-out",
    title: "Cash Out",
    subtitle:
      "Send USDC from your balance to an address on the chain you choose, in one signature. Choose how much with the slider and see the price before you sign.",
  },
  {
    id: "invoices",
    title: "Invoices Paid From Any Chain",
    subtitle:
      "Send a pay link with line items and a due date. Your client pays with USDC or USDT from eight chains, or with ETH, SOL or NEAR, and you see it the moment it lands.",
  },
  {
    id: "checkout",
    title: "A Hosted Checkout",
    subtitle:
      "One API call opens a checkout for an order. The payer picks a coin and a chain, pays from a connected wallet or an exchange, and your store hears back by webhook.",
    card: "A hosted checkout for any store, paid from any chain; your store hears back by webhook.",
  },
  {
    id: "receipts",
    title: "Receipts",
    subtitle:
      "Every payment gets a receipt page and a PDF with its line items, the explorer links and the fingerprint of the terms both sides agreed to.",
    card: "A receipt page and PDF for every payment, with the explorer links and the terms fingerprint.",
  },
  {
    id: "schedule",
    title: "Your Payout Schedule",
    subtitle:
      "Decide when held payments move: after each payment, once a day, once a week or once a month.",
  },
  {
    id: "agents",
    title: "Made For AI Agents",
    subtitle:
      "The MCP server lets an agent check what was paid, fetch receipts, send pay links and prepare invoices. It holds no keys: you sign.",
    card: "An MCP server for your AI agent. It reads and prepares; you approve in your wallet.",
    href: "/agents",
  },
];

export const featureHref = (id: string) =>
  FEATURES.find((f) => f.id === id)?.href ?? `/features#${id}`;
