# Shopify Integration

The Openrail Shopify app lets any USD Shopify store accept stablecoins and native assets (USDC, USDT, ETH, SOL) from 8 supported chains through the Openrail hosted checkout page (`/c/<id>`). Orders are verified against the Shopify GraphQL Admin API (`2025-10`) using 24-hour access tokens acquired via the OAuth client credentials grant, and marked paid automatically via `orderMarkAsPaid` when Openrail books the payment on NEAR.

- **Booking latency:** p50 of 30.5 s on mainnet ([K12 Part A](../../../../evidence/K12-partA-2026-10-29T03-15-27Z.json)), and 40 s to final in the live payment test ([pay report](../../../../evidence/pay-report-2026-10-31T19-13-15-901Z.json)).
- **Cost:** 0.16% at \$50 and 0.79% at \$10 ([K12 Part B](../../../../evidence/K12-partB-amended-2026-10-29T12-13-42Z.json)). ETH and SOL quotes include the up-to-30 bps price-protection margin ([K2' Part B](../../../../evidence/K2prime-partB-2026-10-29T19-11-58Z.json)).

## Architecture & Authentication (Dev Dashboard Client Credentials Grant)

On 1 January 2026, Shopify deprecated legacy custom apps. All new custom apps are created in the **Dev Dashboard** (<https://dev.shopify.com>), which provides an app **Client ID** and **Client secret**.

### Token Lifecycle & 24-Hour Expiration
- Per Shopify's official documentation ([Get API access tokens for Dev Dashboard apps](https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens)), the connector requests a token via `POST https://{shop}.myshopify.com/admin/oauth/access_token` with `grant_type=client_credentials`.
- Shopify returns a token valid for 24 hours (`expires_in: 86399`).
- The connector caches the token in memory, refreshes it automatically 60 seconds before expiration, and retries once on HTTP 401.
- Client secrets are never printed, logged, or reflected in errors (Hard Rule 1).

### Webhook Signing & Final Webhook URLs
- **App-Subscribed Webhook** (`orders/create`): Subscribed with the app via `shopify.app.toml` and deployed via Shopify CLI (`shopify app deploy`). Verified with the app's **Client Secret** (`SHOPIFY_CLIENT_SECRET`) via `X-Shopify-Hmac-Sha256`.
  - **Final URL**: `https://shopify.openrail.incepture.dev/shopify/webhooks`
- **Openrail Webhooks** (`checkout.paid`, `checkout.paid_late`, etc.): Verified with `OPENRAIL_WEBHOOK_SECRET` via `Openrail-Signature`.
  - **Final URL**: `https://shopify.openrail.incepture.dev/shopify/openrail-webhook` (registered by the merchant in Openrail Dashboard under **/app/developers → Webhooks**).

## Workspace Structure, Server Pack & Hosting (Port 8083)

The connector lives in the workspace as `@openrail/shopify` under `services/shopify`:
- Packaged by `deploy/build.sh` inside `services/` in the release archive `openrail-server-<version>.tar.gz`.
- Service unit: `deploy/systemd/openrail-shopify.service`
  - `ConditionPathExists=/opt/openrail/current/services/shopify/src/server.ts`
  - `WorkingDirectory=/opt/openrail/current/services/shopify`
  - `EnvironmentFile=/etc/openrail/shopify.env`
  - `ExecStart=/opt/openrail/current/node_modules/.bin/tsx src/server.ts`
- Environment template: `deploy/env/shopify.env.example`
- Domain: `shopify.openrail.incepture.dev` reverse proxied to `127.0.0.1:8083` via Caddy.

## How a Merchant Installs It

1. **Verify Store Currency is USD**:
   - In Shopify Admin, confirm the store currency is **USD** (**Settings → General → Store defaults**).
2. **Create the App in the Dev Dashboard**:
   - In <https://dev.shopify.com>, click **Create app → Start from Dev Dashboard**. Name the app `Openrail Payments`.
   - Under **Settings**, copy **Client ID** and **Client secret**. Set App URL to `https://shopify.openrail.incepture.dev`.
3. **Configure Client ID & Deploy via Shopify CLI**:
   - Paste the public **Client ID** into `services/shopify/shopify.app.toml` (Shopify CLI does not expand environment variables in TOML).
   - Verify configuration with pre-deploy check:
     ```bash
     cd services/shopify
     bash scripts/check-app-config.sh
     ```
   - Link and deploy:
     ```bash
     shopify app config link
     shopify app deploy
     ```
   This registers the app configuration, scopes (`read_orders,write_orders`), the `orders/create` webhook pointing to `https://shopify.openrail.incepture.dev/shopify/webhooks`, and uploads the checkout UI extension block.
   - *Protected Customer Data note*: Outside development stores, Shopify requires [Protected customer data access](https://shopify.dev/docs/apps/launch/protected-customer-data) for apps receiving customer personal data in `orders/create`. On **development stores**, no review or approval is required. Openrail never accesses or stores customer PII: it extracts only the order ID and fetches financial totals directly via GraphQL Admin API.
4. **Install App on Development Store**:
   - In Dev Dashboard under the app's **Installs** card, click **Install app**, select the dev store, and approve permissions.
5. **Add the Manual Payment Method**:
   - In store admin (**Settings → Payments → Manual payment methods**), create **`Pay with stablecoins (Openrail)`**.
6. **Configure `/etc/openrail/shopify.env` (mode `0600`)**:
   ```ini
   SHOPIFY_SHOP_DOMAIN=your-dev-store.myshopify.com
   SHOPIFY_CLIENT_ID=
   SHOPIFY_CLIENT_SECRET=
   SHOPIFY_ORDER_TOKEN_SECRET=
   SHOPIFY_PORT=8083
   OPENRAIL_API_URL=https://api.openrail.incepture.dev
   OPENRAIL_API_KEY=
   OPENRAIL_WEBHOOK_SECRET=
   APP_BASE_URL=https://shopify.openrail.incepture.dev
   ```
7. **Register Openrail Webhook**:
   - In Openrail Dashboard (**`/app/developers`**, tab **Webhooks**), register `https://shopify.openrail.incepture.dev/shopify/openrail-webhook` for `checkout.paid`, `checkout.partial`, `checkout.paid_late`, `checkout.accepted`, and `checkout.refund_started`.
8. **Enable Checkout UI Extension**:
   - In store admin (**Settings → Checkout → Customize**), add the **Openrail Stablecoin Payment Block** to the **Thank you** and **Order status** pages, then click **Save**.

## Order Status & Webhook Lifecycle

| Openrail Event | Shopify Mutation | Tags Added | Behavior |
|---|---|---|---|
| `checkout.paid` | `orderMarkAsPaid`, `tagsAdd`, `orderUpdate` | `openrail-paid` | Verifies full payment (including any fee line); marks order **Paid**. |
| `checkout.partial` | `tagsAdd`, `orderUpdate` | `openrail-partial` | **Never marks order paid.** Notes received and remaining USD. |
| `checkout.paid_late` | `tagsAdd`, `orderUpdate` | `openrail-late` | **Never marks order paid.** Instructs merchant to review on Openrail dashboard. |
| `checkout.accepted` | `orderMarkAsPaid`, `tagsAdd`, `orderUpdate` | `openrail-accepted` | Marks order **Paid** after merchant accepts late payment. |
| `checkout.refund_started` | `tagsAdd`, `orderUpdate` | `openrail-refund-started` | Notes refund amount and destination. |
| `flagged: true` | `tagsAdd`, `orderUpdate` | `openrail-needs-attention` | Flags order for accounting review. |

## Test Suite & Commands

```bash
pnpm --filter @openrail/shopify test
```

All 22 unit, integration, and server pack tests passing.

## Limitations

- **Payment method.** Without Shopify's Payments Partner approval, the app cannot be a native
  checkout gateway (`write_payment_sessions`, `write_payment_gateways`). The buyer picks the
  manual payment method "Pay with stablecoins (Openrail)" and pays on the order status page.
- **Protected customer data.** Reading an order, marking it paid and the `orders/create`
  webhook need Shopify's protected customer data access, development stores included. Until it
  is granted, the app works from the checkout it created and its own order binding.
- **Buyer name.** The buyer's name is protected data, so Shopify checkouts show "Store
  customer" in the dashboard. The order name (`#1001`) is shown when the app could read the
  order.
- **Currency.** USD orders only; another currency is refused (`unsupported_currency`).

