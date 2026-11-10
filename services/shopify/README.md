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
| **Shopify Store Webhook** (`orders/create`) | Shopify → Openrail Shopify App | `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of raw body) | **Store Webhook Secret** (`SHOPIFY_WEBHOOK_SECRET`) | Configured in Shopify Store Admin under **Settings → Notifications → Webhooks** (Event: *Order creation*, Format: *JSON*, API Version: *2026-04*).<br>Signing key displayed at the bottom of the Notifications page.<br>**Final URL**: `https://shopify.openrail.incepture.dev/shopify/webhooks` |
| **Openrail Webhooks** (`checkout.paid`, `checkout.paid_late`, etc.) | Openrail Checkout API → Shopify App | `Openrail-Signature: t=<unix>,v1=<hex>` (hex HMAC-SHA256 of `<t>.<body>`) | **Openrail Webhook Secret** (`OPENRAIL_WEBHOOK_SECRET`) | Registered in Openrail Merchant Dashboard under **/app/developers → Webhooks**.<br>**Final URL**: `https://shopify.openrail.incepture.dev/shopify/openrail-webhook`<br>Enforces 300 s timestamp tolerance. |

> [!NOTE]
> **Why `orders/create` is created in store admin instead of app-subscribed:**
> Shopify refuses app-level `orders/create` webhook subscriptions in `shopify.app.toml` unless the app has completed Shopify's protected customer data review. The webhook is therefore created in the store admin (**Settings → Notifications → Webhooks**). It is signed with the store-level signing secret displayed on that page and configured in `SHOPIFY_WEBHOOK_SECRET` (not the app client secret). Both extensions (`openrail-checkout` and `openrail-thank-you`) use `api_version = "2026-04"`.

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
4. **Deploy**: You then run `shopify app deploy` in `services/shopify` to link the configuration and deploy the two checkout extensions.

### Summary of Human Login Requirements vs Machine Steps

| Step | Action | Interface | Requires Human Login? |
|---|---|---|---|
| **Step 1** | Create USD Dev Store | Browser (`dev.shopify.com`) | **Yes** (Shopify account login) |
| **Step 2** | Create Dev Dashboard App | Browser (`dev.shopify.com`) | **Yes** (Shopify account login) |
| **Step 3** | Install Shopify CLI & Link Config | Terminal (`shopify app config link`) | **Yes** (Browser OAuth prompt) |
| **Step 4** | Deploy App Config & Extensions | Terminal (`shopify app deploy`) | No (uses CLI credentials from Step 3) |
| **Step 5** | Install App on Dev Store | Browser (`dev.shopify.com` → Install app) | **Yes** (Shopify OAuth grant approval) |
| **Step 6** | Create Store Webhook (`orders/create`) | Browser (`admin.shopify.com` → Notifications) | **Yes** (Store admin login) |
| **Step 7** | Add Manual Payment Method | Browser (`admin.shopify.com/store/...`) | **Yes** (Store admin login) |
| **Step 8** | Add Blocks in Checkout Editor | Browser (Checkout Editor) | **Yes** (Store admin login) |
| **Step 9** | Configure Server Environment | Server shell (`/etc/openrail/shopify.env`) | No (server SSH / admin) |
| **Step 10** | Register Webhook in Openrail | Browser (`dashboard.openrail.../app/developers`) | **Yes** (Openrail account login) |
| **Step 11** | Server Service Startup | Server shell (`openrail-apply`) | No (server SSH / admin) |

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

> **10 Nov correction (orchestrator):** the first extension had no entry point (only a data model), so `shopify app deploy` failed with `No matching export ... for import "default"`. It is now a real Preact extension (`extensions/openrail-thank-you/src/Extension.tsx`, thank-you page; `CheckoutNotice.tsx` is the separate checkout-page block). It asks the connector for the pay link with the buyer's session token (`GET /shopify/extension/pay-link`, verified HS256 with the app's client secret, CORS for the extension's null origin). **Before `shopify app deploy`, run `npm install` once inside each of `extensions/openrail-checkout` and `extensions/openrail-thank-you`.** The CLI will ask to request network access for the extension: approve it (Shopify approves it automatically).

> [!IMPORTANT]
> **Paste your Client ID here before `shopify app deploy`**:
> The Shopify CLI **does not expand environment variables** (e.g. `${SHOPIFY_CLIENT_ID}`) in `shopify.app.toml`. The `client_id` field must contain the literal, public Client ID string copied from the Dev Dashboard.

1. **Verify or set your Client ID in `services/shopify/shopify.app.toml`**:
   ```toml
   name = "Openrail Checkout"
   client_id = "60c714696b8435c0259363c5e1f282e3" # <-- Paste your Client ID here before deploy
   application_url = "https://shopify.openrail.incepture.dev"
   embedded = false

   [access_scopes]
   scopes = "read_orders,write_orders,read_products,write_products,read_inventory,write_inventory,read_customers,write_customers,read_fulfillments,write_fulfillments,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_draft_orders,write_draft_orders,read_discounts,write_discounts,read_price_rules,write_price_rules,read_locations,read_files,write_files"
   use_legacy_install_flow = false

   [auth]
   redirect_urls = [ ]

   [webhooks]
   api_version = "2025-10"

   # No app-subscribed webhook: orders/create carries protected customer data, which the app is not approved for (the
   # release fails). The webhook is created in the store admin instead (Settings > Notifications > Webhooks).

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
   - **Why `orders/create` is omitted from `shopify.app.toml`**: `shopify app deploy` rejects apps subscribing to `orders/create` via TOML unless the app has passed Shopify's protected customer data review.
   - **Store Admin Solution**: Creating the webhook directly in Shopify Store Admin (**Settings → Notifications → Webhooks**) bypasses this constraint for dev stores and uses the store-level signing secret (`SHOPIFY_WEBHOOK_SECRET`).
   - **Zero PII Dependency in Openrail**: The Openrail app does not request or persist customer personal data. When `orders/create` arrives, the webhook handler extracts only the order identifier (`id` or `admin_graphql_api_id`), order display name (e.g. `#1001`), and `payment_gateway_names`. All financial figures (`totalOutstandingSet.shopMoney.amount`, `lineItems`, financial status) are queried directly from the **Shopify Admin GraphQL API** using the server's access token.

4. **Run `shopify app deploy`**:
   ```bash
   shopify app deploy
   ```
   *(In non-interactive CI/CD pipelines, pass `--allow-updates` with `SHOPIFY_APP_AUTOMATION_TOKEN`)*.
   *(Reference: [shopify app deploy](https://shopify.dev/docs/api/shopify-cli/app/app-deploy))*.
   
   **What this command performs**:
   - Synchronizes app configuration (scopes and App URL) to Shopify.
   - Builds and deploys the two Checkout UI extensions (`api_version = "2026-04"`):
     1. `openrail-checkout` ("Openrail Checkout", `purchase.checkout.block.render`, renders pay link on checkout page when Openrail manual method is selected).
     2. `openrail-thank-you` ("Thank You", `purchase.thank-you.block.render`, shows confirmation, tx hash, and order summary).
   - Releases the app version to stores.

---

### Step 5: Install the App on the Development Store (Requires Human Login)
1. Open the Dev Dashboard ([dev.shopify.com](https://dev.shopify.com)) and click on **Openrail Checkout**.
2. On the **Home / Overview** page, locate the **Installs** card and click **Install app** (or three-dot menu `⋯` → **Install app**).
3. Select your development store from the list.
4. An OAuth approval tab will open on your store admin: review requested scopes and click **Install**.

*(Reference: [Create apps using the Dev Dashboard — Install app](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard))*.

---

### Step 6: Create Store Webhook (`orders/create`) in Shopify Admin (Requires Human Login)
1. In Shopify store admin (`https://admin.shopify.com/store/<store-name>`), go to:
   **Settings → Notifications → Webhooks** (scroll to the bottom).
2. Click **Create webhook**:
   - **Event**: `Order creation`
   - **Format**: `JSON`
   - **URL**: `https://shopify.openrail.incepture.dev/shopify/webhooks`
   - **Webhook API version**: `2026-04` (or latest)
3. Click **Save**.
4. Scroll to the bottom of the Webhooks card and copy the **webhook signing key**.
5. Put this key into `SHOPIFY_WEBHOOK_SECRET` in `/etc/openrail/shopify.env` (it is unique to the store, not the app client secret).

---

### Step 7: Add the Manual Payment Method (Requires Human Login)
1. In the Shopify store admin, navigate to:
   **Settings → Payments → Manual payment methods**.
2. Click **Add manual payment method** → **Create custom payment method**.
3. Fill in:
   - **Name**: `Pay with stablecoins (Openrail)`
   - **Additional details**: `Pay with USDC, USDT, ETH, or SOL from 8 supported chains.`
   - **Payment instructions**: `Complete your payment on the order confirmation screen using the Openrail payment card.`
4. Click **Activate**.

---

### Step 8: Add Extension Blocks in the Checkout Editor (Requires Human Login)
1. In Shopify store admin, go to **Settings → Checkout**.
2. In the **Configurations** section, click **Customize** (opens Checkout Editor).
3. On the **Checkout** page:
   - In the bottom-left sidebar, click **Add app block**.
   - Select **Openrail Checkout** (`openrail-checkout`).
   - Position it in the payment/review area.
   - In the settings panel:
     - **Openrail App Base URL**: `https://shopify.openrail.incepture.dev`
     - **Openrail Payment Method Handle**: The handle of your custom manual payment method created in Step 7.
       > [!NOTE]
       > **Why this handle is required:**
       > Per [Shopify Payments API documentation](https://shopify.dev/docs/api/checkout-ui-extensions/latest/target-apis/checkout-apis/payments-api), `SelectedPaymentOption` exposes `handle` and `type` only (`type === "manualPayment"`); provider names, display names, and logos are not available. To ensure the block renders and creates payment links **only** when Openrail is selected (and never for Cash on Delivery, Bank Deposit, or other manual methods), the extension renders only when `openrail_payment_handle` is configured and matches the selected option's handle. If unset, the block safely returns `null` (zero requests, zero UI).
4. In the top dropdown menu, switch from *Checkout* to **Thank you** page:
   - Click **Add app block** and select **Thank You** (`openrail-thank-you`).
   - Drag the block into the desired order summary/status position (e.g. `ORDER_STATUS1`).
5. In the top dropdown, switch to **Order status** page and add the **Thank You** block there as well.
6. Click **Save** in the top-right corner.

*(Reference: [Test checkout UI extensions in the checkout editor](https://shopify.dev/docs/apps/build/checkout/test-checkout-ui-extensions))*.

---

### Step 9: Configure Server Environment (`/etc/openrail/shopify.env`)
On the Openrail host, create `/etc/openrail/shopify.env` (mode `0600 root:root`):

```ini
SHOPIFY_SHOP_DOMAIN=openrail-dev.myshopify.com
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_WEBHOOK_SECRET=
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
| `SHOPIFY_WEBHOOK_SECRET` | Shopify Store Admin → **Settings → Notifications → Webhooks** → signing key at bottom of page. |
| `SHOPIFY_ORDER_TOKEN_SECRET` | Generated random 32-byte hex secret (`openssl rand -hex 32`) for HMAC-signing single-use order tokens. |
| `SHOPIFY_PORT` | `8083` (dedicated port for the Shopify service). |
| `OPENRAIL_API_URL` | Root HTTPS API URL (`https://api.openrail.incepture.dev`). |
| `OPENRAIL_API_KEY` | Openrail Merchant Dashboard → **Settings → API keys** (tick `invoices:read` and `invoices:write`). Starts with `or_sk_live_...`. |
| `OPENRAIL_WEBHOOK_SECRET` | Openrail Merchant Dashboard → **/app/developers → Webhooks** → signing secret (starts with `whsec_...`). |
| `APP_BASE_URL` | Public HTTPS address of the Shopify connector (`https://shopify.openrail.incepture.dev`). |

---

### Step 10: Register the Openrail Webhook in Openrail Dashboard (Requires Human Login)
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

# Run the 52 Shopify unit, extension, and server pack tests:
/home/antigravity/deyoungjohn/openrail/node_modules/.bin/vitest run \
  --root /home/antigravity/deyoungjohn/openrail-lab/staging/shopify \
  test/shopify.test.ts
```

## 7. Updates 11, 12 & 13: Extensions, Real Core API Pagination, Rate Limiting & UI States

### Architecture & Checkout Blocking Decision

1. **Two Distinct Extensions (`api_version = "2026-04"`)**:
   - **`openrail-checkout`** (`purchase.checkout.block.render`): Rendered on the checkout page before the order is placed. Filters for the Openrail manual payment method via `openrail_payment_handle` before requesting `GET /shopify/extension/checkout-pay-link?checkout=<checkoutToken>&amount=<amount>&currency=<currency>` with the buyer's Bearer session token.
   - **`openrail-thank-you`** (`purchase.thank-you.block.render`): Rendered on the post-order confirmation page. Requests `GET /shopify/extension/order-status?order=<orderGid>&checkout=<checkoutToken>` with Bearer session token to display confirmation, transaction hash, and payment summary.

2. **Payment Option Filtering & `openrail_payment_handle`**:
   - Per [Shopify Payments API documentation](https://shopify.dev/docs/api/checkout-ui-extensions/latest/target-apis/checkout-apis/payments-api), `SelectedPaymentOption` exposes `handle` and `type` only (`type === "manualPayment"`); provider names, display names, and logos are not available.
   - To distinguish Openrail from other manual payment methods (e.g. Cash on Delivery or Bank Deposit), the extension requires the merchant to configure `openrail_payment_handle` in the extension settings.
   - If `openrail_payment_handle` is unset, the block safely returns `null` (does not render, zero requests, zero claim storage consumed).

3. **Checkout UI Block Failure Cases & Error Text**:
   - Per AGENTS.md Rule 13, error text never covers a control or causes unexpected page shifts. Space is reserved in `<s-banner>`:

| State / Failure Case | Banner Heading & Tone | Exact Error / Content Text | Behavior |
|---|---|---|---|
| **Unselected / Handle Unset** | *None* | *None (returns `null`)* | Zero DOM nodes rendered, zero network calls, zero layout shift. |
| **Preparing / Loading** | `Pay with stablecoins (Openrail)` (default) | `<s-text>Preparing your payment link…</s-text>` | Displayed while `GET /shopify/extension/checkout-pay-link` is in flight. |
| **Ready / Link Generated** | `Pay with stablecoins (Openrail)` (default) | `<s-button href="{url}">Pay with stablecoins</s-button>` | Buyer clicks button to proceed to Openrail hosted checkout page (`/c/<id>`). |
| **Rate Limited (HTTP 429)** | `Pay with stablecoins` (`warning`) | `<s-text>Too many payment requests. Please wait a moment and try again.</s-text>` | Informs buyer of rate limit without shifting page controls. |
| **Unsupported Currency (HTTP 422)** | `Pay with stablecoins` (`warning`) | `<s-text>Openrail payments only support USD currency at this time.</s-text>` | Informs buyer that store/cart currency must be USD. |
| **Generic / Network Failure** | `Pay with stablecoins` (`warning`) | `<s-text>We could not prepare the payment link. Reload the page or choose another payment method.</s-text>` | Fallback error message. |
| **Thank You Block (Confirmed)** | `Thank you` (`success`) | `<s-text>Your order {number} is confirmed.</s-text>`<br>`<s-text>Transaction: {tx_hash}</s-text>`<br>`<s-text>{summary}</s-text>` | Shows confirmed transaction and payment summary. |
| **Thank You Block (Network Error)** | `Thank you` (`success`) | `<s-text>Your order {number} is confirmed.</s-text>` | Graceful degradation to standard confirmation without error banners covering controls. |

4. **Real Core API Pagination on Cache Miss**:
   - The Openrail Core Checkout API (`GET /v1/checkouts`) takes `limit` (max 100) and `cursor`, returning `{ data: [...], has_more: boolean, next_cursor: string | null }` (sorted newest first by `created_at`). It does not filter by `order_ref`.
   - On process restart / cache miss during `orders/create`, `createHttpCheckoutApiPort.getCheckoutByOrderRef` pages through `GET /v1/checkouts?limit=100` using cursor-based pagination, bounded at 5 pages, matching `order_ref` starting with `shopify-chk-<token>-`.
   - When matched, the connector verifies the actual order total from the Admin GraphQL API (`totalOutstandingSet.shopMoney.amount`). If `paid < total`, the order is tagged `openrail-partial` and never marked paid.

5. **Checkout Progression Decision: Asynchronous (Non-Blocking)**:
   - **Decision**: Do **NOT** block buyer checkout progression using `buyerJourney.intercept` (`block_progress`). The buyer is allowed to place the order in Shopify with financial status `PENDING`, and the order is marked `PAID` via webhook / `orderMarkAsPaid`.
   - **Rationale**:
     1. `buyerJourney.intercept` with `block_progress = true` is explicitly deprecated by Shopify in favor of Checkout Validation Functions.
     2. Merchants can toggle off "Block progress" in the Shopify checkout editor settings at any time, breaking hard-blocking assumptions.
     3. Cross-chain crypto settlements via NEAR Intents take 20–40 seconds across chains (Ethereum, Solana, Arbitrum, etc.). Holding buyers at checkout with a blocking spinner causes abandoned carts if the buyer navigates away or closes the browser before multi-chain inclusion.
     4. Creating the order first guarantees an immutable Shopify order record exists, while supporting pre-payment matching if paid before submission.

6. **Verification Boundaries (What Can & Cannot Be Verified)**:
   - **Can verify**: Session token cryptographic validity (HS256 HMAC signature, expiry, `aud`, `dest`), CORS headers on all extension routes, rate limiting, amount validation, underpayment enforcement, cursor-based pagination against real API response shapes, state reconstruction, webhook matching across both arrival orders, edge-case log lines, and unit/integration test assertions (52/52 passing).
   - **Cannot verify**: Visual layout and CSS rendering of Polaris web components inside the Shopify checkout iframe without a live browser running on a development store session; live `shopify app deploy` execution without interactive human Partner authentication.

## 8. Test Suite (52 tests, `test/shopify.test.ts`)

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
| `shopify_deploy_check_refuses_placeholder_client_id` | Verifies `check-app-config.sh` rejects `${SHOPIFY_CLIENT_ID}`, empty, or `<YOUR_CLIENT_ID>` in `shopify.app.toml` and accepts configured literal client ID |
| `answers a valid session token with a pay link, and CORS headers for the extension's null origin` | `GET /shopify/extension/pay-link` verifies Bearer session token and returns order pay URL with CORS headers |
| `refuses a bad signature, an expired token, another shop and another app` | `GET /shopify/extension/pay-link` returns 401 for bad signature, expired token, wrong shop destination, or wrong audience |
| `needs an order, and answers the browser's preflight` | `GET /shopify/extension/pay-link` returns 400 when order param missing; OPTIONS returns 204 with CORS preflight headers |
| `answers valid session token with a pay_url and CORS headers` | `GET /shopify/extension/checkout-pay-link` creates pre-order invoice keyed by checkout token and returns pay link with CORS |
| `is idempotent: same checkout token returns the same pay_url without re-creating invoice` | Repeat requests with same checkout token return identical `pay_url` without re-creating Openrail checkout |
| `refuses missing checkout token with 400` | `GET /shopify/extension/checkout-pay-link` returns 400 invalid_request when checkout query parameter is missing |
| `refuses non-USD currency with 422` | `GET /shopify/extension/checkout-pay-link` returns 422 unsupported_currency when currency is not USD |
| `refuses invalid or expired session token with 401` | `GET /shopify/extension/checkout-pay-link` returns 401 on missing, expired, or invalid session token |
| `answers OPTIONS preflight with 204 and CORS headers` | `OPTIONS /shopify/extension/checkout-pay-link` returns 204 with CORS headers |
| `pre-paid flow: checkout.paid arrives before orders/create, logs pending order, marks paid when orders/create arrives` | When invoice is paid before Shopify order creation, logs pending order, and subsequent `orders/create` immediately marks order paid and notes booking tx |
| `order-first flow: orders/create arrives before checkout.paid, logs unpaid invoice, marks paid when checkout.paid arrives` | When order is created before payment, logs unpaid invoice, and subsequent `checkout.paid` marks order paid |
| `unmatched paid invoice: invoice paid whose order never appears is logged` | When paid webhook arrives for checkout link but order never appears, logs pending order line and returns 200 |
| `returns order Openrail status, tx hash, and summary with session token` | `GET /shopify/extension/order-status` returns payment status, tx hash, and summary for valid session token and order/checkout query |
| `refuses missing query params with 400` | `GET /shopify/extension/order-status` returns 400 when neither order nor checkout query parameter is passed |
| `returns 404 for unknown order or checkout token` | `GET /shopify/extension/order-status` returns 404 order_not_found for unrecognized order or checkout token |
| `refuses invalid session token with 401` | `GET /shopify/extension/order-status` returns 401 when Bearer session token is invalid |
| `answers OPTIONS preflight with 204 and CORS headers` | `OPTIONS /shopify/extension/order-status` returns 204 with CORS headers |
| `refuses amount missing, non-numeric, or <= 0 with 400 invalid_request` | `GET /shopify/extension/checkout-pay-link` rejects missing, negative, zero, or non-numeric amounts |
| `creates new invoice when cart total differs instead of returning stale link` | Creates new checkout when buyer changes cart total instead of returning stale pay link |
| `underpaid order on orders/create is tagged partial, logged, and NEVER marked as paid` | When paid invoice amount is less than order total on `orders/create`, tags `openrail-partial` and does not mark paid |
| `underpaid payment arriving for existing linked order is tagged partial, logged, and NEVER marked as paid` | When paid invoice amount is less than order total on `checkout.paid`, tags `openrail-partial` and does not mark paid |
| `rate-limits excessive requests per shop and returns 429` | Enforces 60 requests/minute per shop domain on `checkout-pay-link`, returning 429 `rate_limited` |
| `reconstructs binding from Openrail checkout on orders/create when in-memory binding is absent` | Recovers checkout by order ref from Openrail Checkout API on cache miss (e.g. process restart) and marks paid |
| `createHttpCheckoutApiPort.getCheckoutByOrderRef queries GET /v1/checkouts?limit=100 and matches order_ref from real hydrate response` | Pages through `GET /v1/checkouts?limit=100` and extracts matching `order_ref` from `data[]` in real shape |
| `createHttpCheckoutApiPort.getCheckoutByOrderRef pages through multiple pages using cursor` | Navigates across multiple pages using `next_cursor` until match is found |
| `createHttpCheckoutApiPort.getCheckoutByOrderRef returns null on miss` | Returns `null` when no matching checkout exists across all pages |
| `createHttpCheckoutApiPort.getCheckoutByOrderRef bounds pagination to 5 pages max` | Stops after 5 pages even if `has_more: true` to prevent infinite loops |
| `shopify.extension.toml declares openrail_payment_handle setting` | Verifies `openrail_payment_handle` is declared in extension settings |
| `CheckoutPay only renders when openrail_payment_handle is configured and matches selected option` | Verifies block renders only when configured handle matches selected manual option |

## 9. Mutation Spot-Check Table (10 mutants, all killed)

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
