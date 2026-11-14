# Shopify

The Openrail Shopify app adds stablecoins to a USD Shopify store: the buyer chooses "Pay with stablecoins (Openrail)" at checkout and pays from a block on the order page.

> [!NOTE]
> Proven on a real store: the demo development store [belmonte-apparels.myshopify.com](https://belmonte-apparels.myshopify.com) took a $28.00 order paid in USDT on BNB Chain, booked on NEAR mainnet. Its storefront password is in the README. See [Use cases](/use-cases#shopify).

## How it works

1. The buyer checks out and chooses the manual payment method **Pay with stablecoins (Openrail)**. The order is placed.
2. The app receives `orders/create`, reads the order's total from the Shopify Admin API (GraphQL `2025-10`) and creates an Openrail checkout for it.
3. The **Openrail block** on the Thank you and Order status pages shows _Preparing your payment link_, then **Pay with stablecoins**.
4. The buyer pays on the hosted page. Openrail books it and sends the app a signed `checkout.paid`; the app tags and updates the order.

## Install

1. Confirm the store currency is **USD** (Settings → General → Store defaults).
2. In the Shopify Dev Dashboard, create the app _Openrail Payments_; copy its Client ID and secret; set the App URL to the Openrail Shopify service.
3. Put the Client ID in `services/shopify/shopify.app.toml`, run `bash scripts/check-app-config.sh`, then `shopify app config link` and `shopify app deploy`. This registers the scopes (`read_orders,write_orders`), the `orders/create` webhook and the checkout UI extension.
4. Install the app on the store from the Dev Dashboard.
5. Add the manual payment method **Pay with stablecoins (Openrail)** (Settings → Payments).
6. Fill `/etc/openrail/shopify.env` (shop domain, client id and secret, Openrail API key and webhook secret).
7. In Openrail **API Integration → Webhooks**, register the app's webhook URL for the checkout events.
8. Add the **Openrail Stablecoin Payment Block** to the Thank you and Order status pages (Settings → Checkout → Customize).

Access tokens come from the client-credentials grant, last 24 hours, and are refreshed a minute before they expire.

## Order updates

| Openrail event            | What the app does                                                       |
| ------------------------- | ----------------------------------------------------------------------- |
| `checkout.paid`           | Verifies the full amount; tags `openrail-paid`; marks the order paid    |
| `checkout.partial`        | Tags `openrail-partial`; notes received and remaining; never marks paid |
| `checkout.paid_late`      | Tags `openrail-late`; asks the merchant to review                       |
| `checkout.accepted`       | Marks the order paid after the merchant accepts                         |
| `checkout.refund_started` | Tags `openrail-refund-started` with the refund amount                   |

## Limits

- **Not a native gateway.** Without Shopify's Payments Partner approval, an app cannot be a checkout gateway, so the buyer picks a manual method and pays from the order page.
- **Protected customer data.** Reading an order, marking it paid and `orders/create` need Shopify's protected customer data access. Until it is granted, the order is not marked Paid in Shopify; the payment is booked and shown on Openrail.
- **Buyer names** are protected, so these checkouts show "Store customer" in the dashboard.
- **USD stores only.**
