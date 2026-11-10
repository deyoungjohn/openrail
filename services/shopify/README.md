# Staging: Shopify App & Checkout Integration

Parked here until the `shopify` module's gate. Module code must not appear in the public repo before its gate.

## 1. Authentication: Dev Dashboard Client Credentials Grant (24-Hour Tokens)

### Shopify Deprecation of Legacy Custom Apps (1 Jan 2026)
- On **1 January 2026**, Shopify stopped allowing new legacy custom apps in the Shopify Admin ("Settings → Apps and sales channels → Develop apps"). There is no permanent `shpat_` static access token for newly created apps.
- All new custom apps are created in the **Shopify Dev Dashboard** ([dev.shopify.com](https://dev.shopify.com) or Desktop Shopify Admin → click Store Name → **View Dev Dashboard `</>`**).
- The Dev Dashboard provides an app **Client ID** and **Client secret**.
- Per official Shopify documentation ([Get API access tokens for Dev Dashboard apps](https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens) and [Client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant)), the app programmatically requests an Admin API access token using the OAuth **client credentials grant**:
  ```http
  POST https://{shop}.myshopify.com/admin/oauth/access_token
  Content-Type: application/x-www-form-urlencoded

  grant_type=client_credentials&client_id={CLIENT_ID}&client_secret={CLIENT_SECRET}
  ```
- **Token lifecycle**:
  - Shopify returns `{ "access_token": "...", "scope": "read_orders,write_orders", "expires_in": 86399 }`.
  - The token is valid for **24 hours** (`86399` seconds).
  - The Openrail `ShopifyAdminClient` caches the token in memory and automatically refreshes it 60 seconds before expiration (`nowSec < expiresAt - 60`).
  - If Shopify returns an HTTP `401 Unauthorized` on a GraphQL call, the client invalidates the cached token, requests a fresh token, and retries the call once.
  - If a token exchange fails, it raises `token_exchange_failed` with the HTTP status and never includes the client secret or sensitive credentials in the error message (Hard Rule 1).
  - **Static token override**: `SHOPIFY_ADMIN_ACCESS_TOKEN` is retained as an optional fallback for stores with existing legacy apps.

---

## 2. Webhook Signing Architecture (Which Secret Signs Which Webhook)

Shopify and Openrail use distinct webhook signatures:

| Webhook Stream | Direction | Verification Header | Signing Secret Used | Subscription Source & Final URL |
|---|---|---|---|---|
| **App-Subscribed Webhooks** (`orders/create`) | Shopify → Openrail Shopify App | `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of raw body) | **App's Client Secret** (`SHOPIFY_CLIENT_SECRET`) | Subscribed with the app via `shopify.app.toml` and deployed via Shopify CLI (`shopify app deploy`).<br>**Final URL**: `https://shopify.openrail.incepture.dev/shopify/webhooks`<br>*(Zero manual setup in Shopify store admin)*. |
| **Store-Level Webhooks** (manual fallback) | Shopify → Openrail Shopify App | `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of raw body) | **Store Webhook Secret** (`SHOPIFY_WEBHOOK_SECRET`) | Configured manually in Shopify Admin under **Settings → Notifications → Webhooks**.<br>Signing secret displayed at the bottom of the Notifications page. |
| **Openrail Webhooks** (`checkout.paid`, `checkout.paid_late`, etc.) | Openrail Checkout API → Shopify App | `Openrail-Signature: t=<unix>,v1=<hex>` (hex HMAC-SHA256 of `<t>.<body>`) | **Openrail Webhook Secret** (`OPENRAIL_WEBHOOK_SECRET`) | Registered in Openrail Merchant Dashboard under **/app/developers → Webhooks**.<br>**Final URL**: `https://shopify.openrail.incepture.dev/shopify/openrail-webhook`<br>Enforces 300 s timestamp tolerance. |

In the app, `SHOPIFY_WEBHOOK_SECRET` defaults to `SHOPIFY_CLIENT_SECRET`, so Dev Dashboard app-subscribed webhooks work out of the box with zero duplicate secret configuration.

---

## 3. Candidate (1) vs Candidate (2) Approval Comparison

### Official Shopify Rule (Why Candidate 1 Needs Prior Shopify Approval)
1. **Payments Apps API is invitation-only**:
   - Official documentation: [Payments apps extension review](https://shopify.dev/docs/apps/build/payments/payments-extension-review)
   - Quote: *"Before a payments extension can be approved on Shopify's payments platform, two reviews are required: 1. Payments Partner application review; 2. Payments app review... Development: The default state of a payments app is Development, after your first extension version is approved and published. The payments app can then be installed on dev stores for testing purposes."*
2. **Access scopes `write_payment_sessions` and `write_payment_gateways` require Shopify approval**:
   - Official documentation: [Access scopes](https://shopify.dev/docs/api/usage/access-scopes)
   - Cannot be granted on a standard development store without Payments Partner approval.

### Both Shapes Implemented in this Module

| Aspect | Working Development-Store Shape (Active Today, No Approval Needed) | Native Offsite Payments App Shape (With Shopify Payments Partner Approval) |
|---|---|---|
| **Required Scopes** | `read_orders`, `write_orders` (standard Admin API scopes) | `write_payment_sessions`, `read_payment_sessions`, `write_payment_gateways`, `read_payment_gateways` |
| **Checkout Selection** | Buyer chooses manual payment method **"Pay with stablecoins (Openrail)"** and places order. | Buyer chooses native **Openrail** offsite gateway. |
| **Redirect to `/c/<id>`** | Checkout UI Extension (`purchase.thank-you.block.render` & `customer-account.order-status.block.render`) renders **"Pay with stablecoins"** button (`GET /shopify/pay/:order_token`). Reads order amount from Admin GraphQL API and redirects `302` to `/c/<id>`. | Shopify POSTs payment session payload to `POST /shopify/payment_session`; app creates checkout and returns `{"redirect_url": "https://.../c/<id>"}`. |
| **On `checkout.paid`** | Verifies `Openrail-Signature`, verifies full payment (`amount_usd >= total_usd`), calls `orderMarkAsPaid`, adds tag `openrail-paid`, and notes booking tx hash. | Verifies `Openrail-Signature`, verifies full payment, calls `paymentSessionResolve(id, networkTransactionId)` and `orderMarkAsPaid`. |
| **On `checkout.paid_late`** | **Never** calls `orderMarkAsPaid`. Adds tag `openrail-late` and appends note directing merchant to Openrail dashboard. | **Never** calls `paymentSessionResolve`. Adds tag `openrail-late` and notifies merchant. |
| **On `checkout.partial`** | **Never** calls `orderMarkAsPaid`. Adds tag `openrail-partial` and appends note with received/remaining USD amounts. | **Never** calls `paymentSessionResolve`. Adds tag `openrail-partial` and note. |

---

## 4. Hosting & Deployment Architecture (Port 8083)

The Shopify app lives in the workspace as `@openrail/shopify` under `services/shopify` and runs as a dedicated systemd service on port `8083` alongside existing services:
- Port `8080`: Openrail watcher health
- Port `8081`: WooCommerce store container
- Port `8082`: Openrail payout worker
- Port `8083`: Openrail Shopify app (`shopify.openrail.incepture.dev`)

### Workspace & Server Pack Structure
Because the app lives in `services/shopify`, `deploy/build.sh` automatically includes it in the release pack:
```bash
tar -tzf dist/openrail-server-<version>.tar.gz | grep -E '^(services/shopify/|deploy/systemd/openrail-shopify.service|deploy/env/shopify.env.example)'
```

### Deployment Files Included
- **Service Unit**: `deploy/systemd/openrail-shopify.service`
  - `ConditionPathExists=/opt/openrail/current/services/shopify/src/server.ts`
  - `WorkingDirectory=/opt/openrail/current/services/shopify`
  - `EnvironmentFile=/etc/openrail/shopify.env`
  - `ExecStart=/opt/openrail/current/node_modules/.bin/tsx src/server.ts`
  - Auto-discovered and managed by `openrail-apply` without core code naming it.
- **Environment Template**: `deploy/env/shopify.env.example`
  - Variable names only (no values).
  - Automatically discovered and split by `deploy/split-env.sh` from the combined `openrail.env`.
- **Caddy Configuration**: `deploy/Caddyfile.snippet`
  - Reverse proxies `shopify.openrail.incepture.dev` to `127.0.0.1:8083`.
  - HSTS, nosniff, and strict-origin headers.
- **DNS A Record**:
  - `shopify.openrail.incepture.dev` → `SERVER_IP` (configured in server DNS).

---

## 5. How a Merchant Installs It (Exact Dev Dashboard & Shopify CLI Runbook)

### Operator Action: Client ID & Secret Setup
1. **Send me your Client ID**: Visible under Dev Dashboard → Apps → Openrail Payments → **Settings → Client ID** (this is public).
2. **Put your Client secret in `/etc/openrail/shopify.env`**: Set `SHOPIFY_CLIENT_SECRET=...` directly on your server (never send it in chat or logs).
3. **What I will do with the Client ID**: I will write it into `services/shopify/shopify.app.toml`, run `bash scripts/check-app-config.sh` to verify it, and commit the configuration.
4. **Deploy**: You then run `shopify app deploy` in `services/shopify` to link the configuration, register the webhooks, and deploy the checkout extension.

### Summary of Human Login Requirements vs Machine Steps

| Step | Action | Interface | Requires Human Login? |
|---|---|---|---|
| **Step 1** | Create USD Dev Store | Browser (`dev.shopify.com`) | **Yes** (Shopify account login) |
| **Step 2** | Create Dev Dashboard App | Browser (`dev.shopify.com`) | **Yes** (Shopify account login) |
| **Step 3** | Install Shopify CLI & Link Config | Terminal (`shopify app config link`) | **Yes** (Browser OAuth prompt) |
| **Step 4** | Deploy App Config & Extensions | Terminal (`shopify app deploy`) | No (uses CLI credentials from Step 3) |
| **Step 5** | Install App on Dev Store | Browser (`dev.shopify.com` → Install app) | **Yes** (Shopify OAuth grant approval) |
| **Step 6** | Add Manual Payment Method | Browser (`admin.shopify.com/store/...`) | **Yes** (Store admin login) |
| **Step 7** | Add Block in Checkout Editor | Browser (Checkout Editor) | **Yes** (Store admin login) |
| **Step 8** | Register Webhook in Openrail | Browser (`dashboard.openrail.../app/developers`) | **Yes** (Openrail account login) |
| **Step 9** | Server Service Startup | Server shell (`openrail-apply`) | No (server SSH / admin) |

---

### Step 1: Create the Development Store (Requires Human Login)
1. Log in to the **Shopify Dev Dashboard** ([dev.shopify.com](https://dev.shopify.com)) or Partner Dashboard.
2. In the left navigation, click **Dev stores** → click **Create store** → choose **Create development store**.
3. Under **Store details**, confirm store currency is set to **USD**. (*Non-USD stores are refused at install with `422 unsupported_currency`*).
4. Note your dev store domain (e.g. `openrail-dev.myshopify.com`). Both the store and app **must belong to the same Shopify organization**.

---

### Step 2: Create the App in the Dev Dashboard (Requires Human Login)
1. In the Dev Dashboard ([dev.shopify.com](https://dev.shopify.com)), click **Apps** → **Create app**.
2. Select **Start from Dev Dashboard**.
3. Name the app: **`Openrail Payments`**.
4. In the app overview, click **Settings**:
   - Copy **Client ID** (used in `shopify.app.toml` and `/etc/openrail/shopify.env`).
   - Copy **Client secret** (used in `/etc/openrail/shopify.env` for client credentials grant and webhook verification).
   - Under **App URL**, set `https://shopify.openrail.incepture.dev` (or fallback `https://shopify.dev/apps/default-app-home`).

*(Reference: [Create apps using the Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard) and [Get API access tokens for Dev Dashboard apps](https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens))*.

---

### Step 3: Install Shopify CLI and Link Project (Requires Human Login for Browser Auth)
1. Install Shopify CLI globally (Node.js 18.20+ or 20.10+):
   ```bash
   npm install -g @shopify/cli
   # verify installation
   shopify version
   ```
   *(Reference: [About Shopify CLI for apps](https://shopify.dev/docs/apps/build/cli-for-apps))*.
2. Navigate to `services/shopify`:
   ```bash
   cd services/shopify
   ```
3. Link the local project to your Dev Dashboard app:
   ```bash
   shopify app config link
   ```
   Shopify CLI will open a browser window requesting you to log in to Shopify. Select your organization and select the **`Openrail Payments`** app created in Step 2.
   *(Reference: [shopify app config link](https://shopify.dev/docs/api/shopify-cli/app/app-config-link))*.

---

### Step 4: Deploy App Configuration, Webhooks, and Extensions via Shopify CLI

> **10 Nov correction (orchestrator):** the first extension had no entry point (only a data model), so `shopify app deploy` failed with `No matching export ... for import "default"`. It is now a real Preact extension (`extensions/openrail-thank-you-block/src/Extension.tsx`, thank-you page only). It asks the connector for the pay link with the buyer's session token (`GET /shopify/extension/pay-link`, verified HS256 with the app's client secret, CORS for the extension's null origin). **Before `shopify app deploy`, run `npm install` once inside `extensions/openrail-thank-you-block`.** The CLI will ask to request network access for the extension: approve it (Shopify approves it automatically).

> [!IMPORTANT]
> **Paste your Client ID here before `shopify app deploy`**:
> The Shopify CLI **does not expand environment variables** (e.g. `${SHOPIFY_CLIENT_ID}`) in `shopify.app.toml`. The `client_id` field must contain the literal, public Client ID string copied from the Dev Dashboard.

1. **Verify or set your Client ID in `services/shopify/shopify.app.toml`**:
   ```toml
   name = "Openrail Payments"
   client_id = "0193248a-your-real-client-id" # <-- Paste your Client ID here before deploy
   application_url = "https://shopify.openrail.incepture.dev"
   embedded = false

   [access_scopes]
   scopes = "read_orders,write_orders"

   [webhooks]
   api_version = "2025-10"

   [[webhooks.subscriptions]]
   topics = [ "orders/create" ]
   uri = "https://shopify.openrail.incepture.dev/shopify/webhooks"

   [build]
   automatically_update_urls_on_dev = false
   ```
   *(Reference: [App configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration))*.

2. **Run the pre-deploy check**:
   ```bash
   bash scripts/check-app-config.sh
   ```
   *This validator ensures that `client_id` is neither empty nor an unexpanded placeholder (e.g. `${...}` or `<...>`)*.

3. **Protected Customer Data & `orders/create` Handling**:
   - **What Shopify Requires**: By default, `orders/create` payloads contain customer personal data (names, email, phone, addresses). Outside development stores, Shopify requires apps to request [Protected customer data access](https://shopify.dev/docs/apps/launch/protected-customer-data) in the Dev Dashboard / Partner Dashboard under **App → Settings → Data and privacy** and complete the data protection review.
   - **Development Store Rule**: **Development stores do NOT require a review or approval**. Shopify automatically allows access to customer data during development and testing on dev stores without submitting a review request ([Work with protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data)).
   - **Zero PII Dependency in Openrail**: The Openrail app does not request or persist customer personal data. When `orders/create` arrives, the webhook handler extracts only the order identifier (`id` or `admin_graphql_api_id`), order display name (e.g. `#1001`), and `payment_gateway_names`. All financial figures (`totalOutstandingSet.shopMoney.amount`, `lineItems`, financial status) are queried directly from the **Shopify Admin GraphQL API** using the server's access token. Even if Shopify redacts customer fields in production, Openrail operates normally.

4. **Run `shopify app deploy`**:
   ```bash
   shopify app deploy
   ```
   *(In non-interactive CI/CD pipelines, pass `--allow-updates` with `SHOPIFY_APP_AUTOMATION_TOKEN`)*.
   *(Reference: [shopify app deploy](https://shopify.dev/docs/api/shopify-cli/app/app-deploy))*.
   
   **What this command performs**:
   - Synchronizes app configuration (scopes `read_orders,write_orders` and App URL) to Shopify.
   - Automatically subscribes `orders/create` to `https://shopify.openrail.incepture.dev/shopify/webhooks` signed with the app's **Client Secret**.
   - Builds and deploys the Checkout UI extension `openrail-thank-you-block` (targets `purchase.thank-you.block.render` and `customer-account.order-status.block.render`).
   - Releases the app version to stores.

---

### Step 5: Install the App on the Development Store (Requires Human Login)
1. Open the Dev Dashboard ([dev.shopify.com](https://dev.shopify.com)) and click on **Openrail Payments**.
2. On the **Home / Overview** page, locate the **Installs** card and click **Install app** (or three-dot menu `⋯` → **Install app**).
3. Select your development store from the list.
4. An OAuth approval tab will open on your store admin: review requested scopes (`read_orders`, `write_orders`) and click **Install**.

*(Reference: [Create apps using the Dev Dashboard — Install app](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard))*.

---

### Step 6: Add the Manual Payment Method (Requires Human Login)
1. In the Shopify store admin (`https://admin.shopify.com/store/<store-name>`), navigate to:
   **Settings → Payments → Manual payment methods**.
2. Click **Add manual payment method** → **Create custom payment method**.
3. Fill in:
   - **Name**: `Pay with stablecoins (Openrail)`
   - **Additional details**: `Pay with USDC, USDT, ETH, or SOL from 8 supported chains.`
   - **Payment instructions**: `Complete your payment on the order confirmation screen using the Openrail payment card.`
4. Click **Activate**.

---

### Step 7: Add Extension Block in the Checkout Editor (Requires Human Login)
1. In Shopify store admin, go to **Settings → Checkout**.
2. In the **Configurations** section, click **Customize** (opens Checkout Editor).
3. In the top dropdown menu, switch from *Checkout* to **Thank you** page.
4. In the bottom-left sidebar, click **Add app block**.
5. Select **Openrail Stablecoin Payment Block** (`openrail-thank-you-block`).
6. In the right-hand settings panel, verify **Openrail App Base URL** is set to `https://shopify.openrail.incepture.dev`.
7. Drag the block into the desired order summary/status position (e.g. `ORDER_STATUS1`).
8. Switch the top dropdown to **Order status** page and repeat (click **Add app block**, select **Openrail Stablecoin Payment Block**, position it).
9. Click **Save** in the top-right corner.

*(Reference: [Test checkout UI extensions in the checkout editor](https://shopify.dev/docs/apps/build/checkout/test-checkout-ui-extensions))*.

---

### Step 8: Configure Server Environment (`/etc/openrail/shopify.env`)
On the Openrail host, create `/etc/openrail/shopify.env` (mode `0600 root:root`):

```ini
SHOPIFY_SHOP_DOMAIN=openrail-dev.myshopify.com
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_ORDER_TOKEN_SECRET=
SHOPIFY_PORT=8083

OPENRAIL_API_URL=https://api.openrail.incepture.dev
OPENRAIL_API_KEY=
OPENRAIL_WEBHOOK_SECRET=
APP_BASE_URL=https://shopify.openrail.incepture.dev
```

### Every Value and Where It Comes From:
| Environment Variable | Where in Shopify or Openrail It Comes From |
|---|---|
| `SHOPIFY_SHOP_DOMAIN` | The `*.myshopify.com` domain of your dev store (e.g. `openrail-dev.myshopify.com`). |
| `SHOPIFY_CLIENT_ID` | Dev Dashboard → Apps → Openrail Payments → **Settings → Client ID**. |
| `SHOPIFY_CLIENT_SECRET` | Dev Dashboard → Apps → Openrail Payments → **Settings → Client secret**. |
| `SHOPIFY_ORDER_TOKEN_SECRET` | Generated random 32-byte hex secret (`openssl rand -hex 32`) for HMAC-signing single-use order tokens. |
| `SHOPIFY_PORT` | `8083` (dedicated port for the Shopify service). |
| `OPENRAIL_API_URL` | Root HTTPS API URL (`https://api.openrail.incepture.dev`). |
| `OPENRAIL_API_KEY` | Openrail Merchant Dashboard → **Settings → API keys** (tick `invoices:read` and `invoices:write`). Starts with `or_sk_live_...`. |
| `OPENRAIL_WEBHOOK_SECRET` | Openrail Merchant Dashboard → **/app/developers → Webhooks** → signing secret (starts with `whsec_...`). |
| `APP_BASE_URL` | Public HTTPS address of the Shopify connector (`https://shopify.openrail.incepture.dev`). |

---

### Step 9: Register the Openrail Webhook in Openrail Dashboard (Requires Human Login)
In the Openrail Merchant Dashboard:
1. Navigate to **`/app/developers`**, tab **Webhooks**.
2. Click **Add endpoint**.
3. **Endpoint URL**: `https://shopify.openrail.incepture.dev/shopify/openrail-webhook`
4. **Events to subscribe**:
   - `checkout.paid`
   - `checkout.paid_late`
   - `checkout.partial`
   - `checkout.accepted`
   - `checkout.refund_started`
5. Copy the generated signing secret into `OPENRAIL_WEBHOOK_SECRET` in `/etc/openrail/shopify.env`.

---

## 6. How to Apply Patches and Run Tests

```bash
# Apply patch series to openrail:
git -C openrail switch -c mod-shopify origin/main
git -C openrail am ../openrail-lab/staging/shopify/patches/*.patch

# Run the 22 Shopify unit and server pack tests:
/home/antigravity/deyoungjohn/openrail/node_modules/.bin/vitest run \
  --root /home/antigravity/deyoungjohn/openrail-lab/staging/shopify \
  test/shopify.test.ts
```

## 7. Test Suite (22 tests, `test/shopify.test.ts`)

| Test | What it proves |
|---|---|
| `shopify_amount_from_admin_api_not_browser` | Reads `totalOutstandingSet.shopMoney.amount` from Shopify Admin GraphQL API; ignores tampered query/body `amount` or `order_ref` |
| `shopify_order_token_single_use` | HMAC-signed order token redirects once (`302`), rejects replay (`410 order_token_already_used`), rejects bad signature (`401 invalid_order_token`), and rejects expired token (`401 expired_order_token`) |
| `shopify_mark_paid_only_on_full_payment` | Refuses underpaid webhook (`409 insufficient_payment_amount` when `pass_to_customer` fee is missing); calls `orderMarkAsPaid` only when `amount_usd >= total_usd` |
| `shopify_partial_tagged_not_paid` | `checkout.partial` never calls `orderMarkAsPaid`; adds tag `openrail-partial` and note with received/remaining USD |
| `shopify_mark_paid_idempotent` | Duplicate Openrail `event.id` or repeat delivery on an already-paid order makes zero duplicate `orderMarkAsPaid` calls |
| `shopify_non_usd_refused` | Refuses non-USD shops at install (`422 unsupported_currency`), non-USD orders at `/shopify/pay/:token`, and non-USD payment sessions |
| `verifies Shopify webhook X-Shopify-Hmac-Sha256 and Openrail-Signature headers` | Timing-safe base64 HMAC-SHA256 check for Shopify webhooks and 300 s timestamp window check for `Openrail-Signature` |
| `handles Shopify orders/create webhook, verifies HMAC, and issues a single-use pay URL` | Verifies `orders/create` webhook, filters for Openrail gateway, and issues `/shopify/pay/:order_token` |
| `handles checkout.paid_late without marking order paid or resolving payment session, and notifies merchant` | Repeated session is idempotent; `checkout.paid_late` never resolves session or marks order paid, adds `openrail-late` tag and dashboard instructions |
| `resolves offsite payment session and marks order paid when checkout.paid or checkout.accepted arrives` | Calls `paymentSessionResolve(id, networkTransactionId)` and `orderMarkAsPaid` on full payment |
| `handles checkout.accepted, checkout.refund_started, and flagged checkouts` | Tags `openrail-needs-attention` on `flagged: true`, `openrail-refund-started` on `checkout.refund_started`, and marks paid on `checkout.accepted` |
| `enforces MISSING_ENV guard without printing secret values and parses CRLF env files` | Throws `MISSING_ENV: <NAME>` when any required variable is missing; never prints secrets |
| `builds Checkout UI Extension thank-you block model without exposing amount parameters in URL` | Hides block when paid or non-USD; renders CTA to `/shopify/pay/:order_token` with no amount query param |
| `sends verified GraphQL queries and mutations in ShopifyAdminClient and ShopifyPaymentsAppClient` | Verifies exact GraphQL endpoint URLs (`/admin/api/2025-10/graphql.json` and `/payments_apps/api/2025-10/graphql.json`), headers, and variables |
| `shopify_client_credentials_token_fetched_once_and_reused` | Exchanging Client ID and Secret calls `/admin/oauth/access_token` once; reuses token across multiple calls |
| `shopify_client_credentials_refetched_after_expiry` | Caches 24-hour token in memory; automatically refreshes token when nearing expiration (60 s buffer) |
| `shopify_client_credentials_refetched_after_401` | When GraphQL returns 401 Unauthorized, automatically clears cached token, requests a fresh token, and retries call |
| `shopify_client_credentials_failing_exchange_named_error_no_secret` | Failing token exchange throws `token_exchange_failed` and never exposes the client secret in the error |
| `shopify_static_token_override_still_works` | Legacy `SHOPIFY_ADMIN_ACCESS_TOKEN` is used directly without calling token endpoint |
| `shopify_app_health_endpoint` | `GET /health` returns HTTP 200 `{"ok":true}` |
| `shopify_http_listener_handles_requests_and_payload_limits` | HTTP server listener dispatches requests and rejects payloads > 1 MB with `413 payload_too_large` |
| `shopify_server_pack_includes_service_and_unit` | Validates package `@openrail/shopify`, `shopify.app.toml`, `openrail-shopify.service` unit configuration for `services/shopify`, and server pack `tar -tzf` contents |

## 8. Mutation Spot-Check Table (10 mutants, all killed)

| Mutant | Component | Code Mutation | Killing Test |
|---|---|---|---|
| **M1** | `app.ts` | Read `req.query.amount_usd` instead of `order.totalOutstandingSet.shopMoney.amount` | `shopify_amount_from_admin_api_not_browser` |
| **M2** | `hmac.ts` | Skip `consumedNonces.has(nonce)` check in `OrderTokenStore.consume` | `shopify_order_token_single_use` |
| **M3** | `app.ts` | Compare `paidUsd` against `subtotal_usd` instead of `total_usd` under `pass_to_customer` | `shopify_mark_paid_only_on_full_payment` |
| **M4** | `app.ts` | Call `markOrderAsPaid` inside `checkout.partial` handler | `shopify_partial_tagged_not_paid` |
| **M5** | `app.ts` | Remove `processedEventIds.has(event.id)` deduplication check | `shopify_mark_paid_idempotent` |
| **M6** | `app.ts` | Allow non-USD `shop.currencyCode` or `shopMoney.currencyCode` | `shopify_non_usd_refused` |
| **M7** | `app.ts` | Call `paymentSessionResolve` or `markOrderAsPaid` on `checkout.paid_late` | `handles checkout.paid_late without marking order paid or resolving payment session, and notifies merchant` |
| **M8** | `admin-client.ts` | Always request fresh token on every GraphQL call without cache | `shopify_client_credentials_token_fetched_once_and_reused` |
| **M9** | `admin-client.ts` | Do not retry upon HTTP 401 | `shopify_client_credentials_refetched_after_401` |
| **M10** | `admin-client.ts` | Include client secret in error message upon token exchange failure | `shopify_client_credentials_failing_exchange_named_error_no_secret` |
