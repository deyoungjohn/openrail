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

3. **Protected Customer Data, Webhook Fallback & Dual Support**:
   - **Development Stores Are NOT Exempt**: Development stores are not exempt from Shopify's protected customer data requirements. Live testing confirms Shopify blocks Admin API access to the `Order` GraphQL object with error: `Shopify Admin GraphQL error: This app is not approved to access the Order object. See https://shopify.dev/docs/apps/launch/protected-customer-data`.
   - **What the App Needs**: Level 1 access to the `Order` object in the Shopify Dev Dashboard. No customer PII fields (name, email, phone, physical address) are requested or needed—only the order ID, line items, and financial totals.
   - **What Happens Without Approval (Fallback Flow)**:
     - The store-admin webhook (`orders/create`, signed with `SHOPIFY_WEBHOOK_SECRET`) is not gated by app review and delivers order identifiers (`id`, `admin_graphql_api_id`), totals, currency, confirmation number, and payment gateway names.
     - The connector builds an in-memory binding from the webhook payload. Both `GET /shopify/extension/pay-link` and `GET /shopify/extension/order-status` answer directly from this binding, without calling `getOrder` through the Admin API.
     - **The Race Window**: If the Thank-You page loads before the webhook arrives, `order-status` returns HTTP `202 {"status":"order_pending"}` for up to 2 minutes after first seeing the order ID. The extension polls quietly displaying "Preparing your payment link…", transitioning to 200 once the webhook arrives. If 2 minutes elapse without a webhook binding, it answers 404 `order_not_found`.
     - **Marking Paid**: When payment is booked on NEAR, the connector attempts `orderMarkAsPaid`. If refused due to protected customer data, it logs `[shopify] cannot mark order <id> paid: the app is not approved for protected customer data; request access in the Dev Dashboard`, records the binding as `paid`, and serves the paid state to the buyer with NEAR transaction links. Shopify's order remains 'payment pending' and the merchant marks it paid by hand.
   - **Where to Request Access**:
     - *Verified on shopify.dev*: Open Dev Dashboard ([dev.shopify.com](https://dev.shopify.com)) → Select App → **API access** → **Protected customer data** ([Shopify Protected Customer Data Documentation](https://shopify.dev/docs/apps/launch/protected-customer-data)). Request Level 1 access for Order data.
     - *Unverified boundary*: In some Dev Dashboard configurations, the request form may not be exposed for development-tier custom apps. The webhook binding provides complete functionality regardless of approval status.

4. **Run `shopify app deploy`**:
   ```bash
   shopify app deploy
   ```
   *(In non-interactive CI/CD pipelines, pass `--allow-updates` with `SHOPIFY_APP_AUTOMATION_TOKEN`)*.
   *(Reference: [shopify app deploy](https://shopify.dev/docs/api/shopify-cli/app/app-deploy))*.
   
   **What this command performs**:
   - Synchronizes app configuration (scopes and App URL) to Shopify.
   - Builds and deploys the default Checkout UI extension (`api_version = "2026-04"`):
     - `openrail-thank-you` ("Thank You", `purchase.thank-you.block.render`, shows 3 distinct states: unpaid, partial, paid with tx hash and order summary).
   - Releases the app version to stores.
   - *(Note: `openrail-checkout` lives in `optional/openrail-checkout/` for Shopify Plus stores; see Plus Stores section below).*

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

### Step 8: Add the Thank You Block in Checkout Editor (Requires Human Login)
1. In Shopify store admin, go to **Settings → Checkout**.
2. In the **Configurations** section, click **Customize** (opens Checkout Editor).
3. In the top dropdown menu, switch to **Thank you** page:
   - Click **Add app block** and select **Thank You** (`openrail-thank-you`).
   - Drag the block into the desired order summary/status position (e.g. `ORDER_STATUS1`).
   - *(Note: Zero manual handle configuration is required. The block automatically checks the order's payment gateway via Admin API and renders `null` for non-Openrail orders).*
4. In the top dropdown, switch to **Order status** page and add the **Thank You** block there as well.
5. Click **Save** in the top-right corner.

*(Reference: [Test checkout UI extensions in the checkout editor](https://shopify.dev/docs/apps/build/checkout/test-checkout-ui-extensions))*.

---

### Step 9: Configure Server Environment (`/etc/openrail/shopify.env`)
On the Openrail host, create `/etc/openrail/shopify.env` (mode `0600 root:root`):

```ini
# bare host, for example belmonte-apparels.myshopify.com, no https://
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
| `SHOPIFY_SHOP_DOMAIN` | Bare host, for example `belmonte-apparels.myshopify.com`, no https://. The `*.myshopify.com` domain of your dev store. |
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

# Run the 117 Shopify unit, extension, and server pack tests:
/home/antigravity/deyoungjohn/openrail/node_modules/.bin/vitest run \
  --root /home/antigravity/deyoungjohn/openrail-lab/staging/shopify \
  test/shopify.test.ts
```

## 7. Updates 14, 15, 16, 17 & 18: Post-Order Thank-You Flow, Landing Page, Failure Resilience & ID Normalization

### Standard Merchant Flow: Thank-You Page Post-Order Payment (Believed Available on All Paid Plans)
Per Shopify documentation on checkout extensibility, checkout page steps (information, shipping, payment) are restricted to **Shopify Plus** stores in production. The Thank-You page (`purchase.thank-you.block.render`) and Order Status page are believed available; to be confirmed on a Basic store.

1. **Buyer Journey**:
   - Buyer selects manual payment method **"Pay with stablecoins (Openrail)"** and places the order in Shopify.
   - The order is created in Shopify with financial status `PENDING`.
   - Buyer lands on the **Thank you** page.
   - The Openrail Thank You block mounts, retrieves the order GID and confirmation number from `orderConfirmation`, and checks `GET /shopify/extension/order-status?order=<gid>&confirmation=<number>`.
   - The block renders one of three states. Non-Openrail orders return 404 and the block renders `null` (nothing), requiring zero manual handle settings.
   - Polling: polls `GET /shopify/extension/order-status` every 5 seconds for at most 15 minutes (stopping on tab hide or unmount). Transitions immediately when status becomes `paid`. It **never says thanks before money is booked**.

2. **Thank You Block States & Exact Copy**:

| State | Heading | Text | Action Button | Summary | Tone |
|---|---|---|---|---|---|
| **unpaid** | `Order placed` | `Complete your payment with stablecoins to confirm this order.` | `Pay with stablecoins` (links to Openrail hosted checkout `/c/<id>`) | Order total (e.g. `Order total: $2.00 USD`) | *Default* |
| **partial** | `Partial payment received` | `We received <paid> of <total>. Please send the remaining <remaining> to complete your order.` | `Pay remaining balance` (links to pay link) | Amounts received & remaining | *Default* |
| **paid** | `Thank you, payment received` | `Your payment was confirmed on NEAR.` | *None* | Booking transaction hash with NEAR Explorer link (`https://nearblocks.io/txns/<hash>`), amount paid, order reference | `success` |
| **error** | `Payment status unavailable` | `We could not load the payment status for this order. Reload the page, or contact the shop.` | *None* | *None* | `warning` |

3. **Install Redirect Landing Page (`GET /`)**:
   - Responds with HTTP `200` `text/html; charset=utf-8`.
   - Text: *"Openrail Checkout is installed on this store. Manage settings in your Shopify Admin under Settings → Checkout and Settings → Payments."*
   - Completely static: zero `<script>` tags, zero reflected query parameters (eliminating XSS), zero secrets leaked, and zero external Shopify API calls.
   - Preserves `/health` for systemd and reverse-proxy health checks.

4. **Plus Stores: Optional Pre-Order Payment Link (`optional/openrail-checkout`)**:
   - For merchants on Shopify Plus who wish to display the payment link on the checkout payment step before order creation:
     1. Move extension: `mv optional/openrail-checkout extensions/openrail-checkout`.
     2. In `/etc/openrail/shopify.env`, set `SHOPIFY_PRE_ORDER_LINK=1` (returns 404 when unset or 0).
     3. Deploy via `shopify app deploy`.
     4. In Checkout Editor, configure `openrail_payment_handle` on the block.
   - The connector guarantees order independence across both arrival orders (`orders/create` before `pay-link` and `pay-link` before `orders/create`), creating exactly 1 invoice and 0 duplicates.

5. **Update 16: Security, Caller Binding, Rate Limiting & Partial State Recovery**:
   - **Rate Limiting**: `GET /shopify/extension/pay-link` and `GET /shopify/extension/order-status` enforce a sliding window rate limit of 60 requests per 60 seconds per shop domain (`429 rate_limited`).
   - **Read-Only Status**: `GET /shopify/extension/order-status` is strictly read-only on cache miss and never triggers checkout or invoice creation (creation happens exclusively in `GET /shopify/extension/pay-link`).
   - **Caller Binding & Information Minimization**:
     - The Thank-You extension extracts the random confirmation number from `shopify.orderConfirmation.value.number` (or `current.number`) and passes `&confirmation=<value>`.
     - In `GET /shopify/extension/pay-link`: `confirmation` parameter is required and validated against the Admin API order (`confirmationNumber`, `name` with/without `#`, or `statusPageUrl` token). If missing or mismatched, returns `403 order_access_denied`.
     - In `GET /shopify/extension/order-status`: If `confirmation` matches, returns full order details (amounts, pay URL, tx hash). If `confirmation` is missing or mismatched, returns a minimized response (`status` and generic `summary` only; omitting `total_usd`, `paid_usd`, `remaining_usd`, `pay_url`, `tx_hash`, and `checkout_id`) to prevent financial information leakage.
   - **Empty Gateway & Zero Total Hardening**:
     - If `payment_gateway_names` is empty or does not include an Openrail payment method, returns `404 not_openrail_order` (preventing draft or free orders from being mistaken as Openrail orders).
     - If order total is `$0.00` or negative (checked via `currentTotalPriceSet` or `totalOutstandingSet`), returns `404 not_openrail_order`.
   - **Partial State Recovery on Restart**:
     - When recovering checkout bindings from the Openrail API after a process restart or cache miss, partial payment values (`paid_usd` and `remaining_usd`) are reconstructed from the recovered checkout entity in both `order-status` and the `orders/create` webhook handler.

6. **Update 17: Visible Failure States & Error Resilience (No Silent Failures)**:
   - **Silent Failure Elimination**: Previously, `null` was returned on all fetch failures (missing session token, network errors, 401, 500), which made backend errors look identical to "not an Openrail order".
   - **Strict 404 Discriminator**: **Only** an HTTP 404 with error code `not_openrail_order` or `order_not_found` renders `null`. All other 404s (e.g. reverse-proxy routing failures or server missing-route HTML) render the visible warning banner.
   - **Warning Banner State**: Any other failure (missing token, 401, 403, 429, 5xx, network error, unparsable body) renders a visible `<s-banner tone="warning">` with heading `"Payment status unavailable"` and sentence `"We could not load the payment status for this order. Reload the page, or contact the shop."` with no other controls, reserving space (AGENTS.md Rule 13).
   - **Polling Resilience**: During polling, transient network/server glitches retain the last good state (`unpaid`, `partial`, or `paid`) and suppress the error banner until **three failures in a row** (`consecutiveFailures >= 3`). A subsequent successful poll clears failure counters and restores normal rendering.
   - **Operator Browser Logging**: Logs `console.warn("[openrail] order-status failed", status)` on every failure, passing only the status code or error label (e.g. `401`, `500`, `"network_error"`, `"no_token"`, `"unparsable_body"`), with zero session tokens or response bodies logged.

7. **Update 18: Order ID Normalization, Validation Guard & Session Token Refusal Logging**:
   - **Order ID & `OrderIdentity` GID Normalization**:
     - On real Thank-You extension runtimes, `shopify.orderConfirmation.value.order.id` provides `gid://shopify/OrderIdentity/<numeric_id>` (despite Shopify documentation claiming it corresponds to Admin API `Order` GID). In Shopify Admin GraphQL API, queries require `gid://shopify/Order/<numeric_id>`.
     - The connector accepts both `gid://shopify/Order/<n>` and `gid://shopify/OrderIdentity/<n>`, as well as bare numeric strings `<n>`, across `pay-link`, `order-status`, `bindingsByOrderGid` lookups, and `orders/create` webhook bindings.
     - Internally normalizes to numeric ID `<n>` for in-memory binding maps and to `gid://shopify/Order/<n>` for Shopify Admin API queries and order notes.
   - **Strict 400 Validation**: Rejects non-numeric bare strings or other GID types (e.g. `gid://shopify/Product/<n>`, `gid://shopify/Customer/<n>`) with HTTP 400 `invalid_request`.
   - **Throttled Session Token Refusal Logging**: Logs `console.warn("[shopify] session token refused:", reason)` throttled to at most once per 60 seconds per refusal reason (`bad_signature`, `expired`, `wrong_shop`, `wrong_app`, `missing`), writing reason only (never the token) so operators see configuration mismatches in `journalctl`.

8. **Verification Boundaries (What Can & Cannot Be Verified)**:
   - **Can verify**: Session token cryptographic validity (HS256 HMAC signature, expiry, `aud`, `dest`), throttled operator refusal logs, CORS headers on all extension routes, rate limiting, caller confirmation binding, information minimization, error banner states and 3-failure polling thresholds, order identity normalization, amount validation, underpayment enforcement, cursor-based pagination against real API response shapes, partial state reconstruction, webhook matching across both arrival orders, edge-case log lines, and unit/integration test assertions (117/117 passing).
   - **Cannot verify**: Visual layout and CSS rendering of Polaris web components inside the Shopify checkout iframe without a live browser running on a development store session; live `shopify app deploy` execution without interactive human Partner authentication.

## 8. Test Suite (120 tests, `test/shopify.test.ts`)

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
| `GET / answers 200 text/html with static landing page` | Answers 200 text/html static landing page on root without script, XSS reflection, or Shopify API call |
| `preserves /health endpoint alongside landing page` | Verifies GET /health answers 200 `{"ok":true}` independently of landing page |
| `returns 404 when SHOPIFY_PRE_ORDER_LINK is not set or not '1'` | Gated route `GET /shopify/extension/checkout-pay-link` returns 404 when SHOPIFY_PRE_ORDER_LINK is unset |
| `returns 200 when SHOPIFY_PRE_ORDER_LINK='1'` | Gated route returns 200 with pay link when SHOPIFY_PRE_ORDER_LINK is set to 1 |
| `builds view model for unpaid state` | Verifies ThankYouModel output for unpaid state: heading, text, Pay with stablecoins button, order total |
| `builds view model for partial state` | Verifies ThankYouModel output for partial state: heading, received/remaining text, Pay remaining balance button |
| `builds view model for paid state with transaction link` | Verifies ThankYouModel output for paid state: heading, NEAR confirmed text, NEAR Explorer link |
| `does not render when status is null (non-Openrail order)` | Verifies ThankYouModel returns render: false for non-Openrail orders |
| `requires valid session token` | Verifies GET /shopify/extension/pay-link returns 401 without Bearer session token |
| `refuses non-Openrail gateway with 404` | Verifies pay-link returns 404 not_openrail_order for orders not using Openrail payment method |
| `issues single invoice from Admin API total and is idempotent` | Issues single invoice from Admin API total and returns existing checkout on subsequent calls |
| `Path A: orders/create webhook arrives before pay-link -> exactly 1 checkout created, 0 duplicates` | Webhook before pay-link creates exactly 1 checkout and 0 duplicates |
| `Path B: pay-link called before orders/create webhook -> exactly 1 checkout created, 0 duplicates` | Pay-link before webhook creates exactly 1 checkout and 0 duplicates |
| `refuses non-Openrail orders with 404` | Verifies GET /shopify/extension/order-status returns 404 for non-Openrail orders |
| `returns unpaid state with pay_url on cache miss for Openrail order` | Queries Admin API on miss, creates checkout, returns unpaid with pay URL |
| `returns paid state with tx_hash and summary once payment is booked` | Returns paid state with booking transaction hash and summary once payment is booked on NEAR |
| `GET /shopify/extension/pay-link rate-limits excessive requests per shop domain with 429` | Sliding window rate limits pay-link requests to 60 req/60s per shop domain |
| `GET /shopify/extension/order-status rate-limits excessive requests per shop domain with 429` | Sliding window rate limits order-status requests to 60 req/60s per shop domain |
| `GET /shopify/extension/order-status is strictly read-only and never creates checkout or invoice on cache miss` | Verifies order-status NEVER triggers createCheckout, preserving strictly read-only semantics |
| `GET /shopify/extension/pay-link returns 404 not_openrail_order when payment_gateway_names is empty` | Refuses orders with empty gateway names list (e.g. draft/free orders) |
| `GET /shopify/extension/order-status returns 404 not_openrail_order when payment_gateway_names is empty` | Order status returns 404 when payment gateway names list is empty |
| `GET /shopify/extension/pay-link returns 404 not_openrail_order when order total is 0.00 or negative` | Refuses zero-dollar or negative orders with 404 not_openrail_order |
| `GET /shopify/extension/order-status returns 404 not_openrail_order when order total is 0.00 or negative` | Order status returns 404 when total is 0.00 or negative |
| `GET /shopify/extension/pay-link requires confirmation query matching order confirmationNumber or name, else 403 order_access_denied` | Rejects pay-link when confirmation parameter is missing with 403 order_access_denied |
| `GET /shopify/extension/pay-link succeeds when confirmation matches order name (with or without hash)` | Binds caller when confirmation parameter matches order name (e.g. #1001 or 1001) |
| `GET /shopify/extension/pay-link succeeds when confirmation matches token from statusPageUrl` | Binds caller when confirmation matches token slug in order's statusPageUrl |
| `GET /shopify/extension/pay-link rejects mismatched confirmation with 403 order_access_denied` | Rejects pay-link when confirmation does not match order confirmationNumber, name, or status url |
| `GET /shopify/extension/order-status returns minimized response (no amounts, pay_url, tx_hash) when confirmation is missing` | Prevents information leakage: returns only status and generic summary without amounts, pay_url, or tx_hash when confirmation missing |
| `GET /shopify/extension/order-status returns minimized response when confirmation does not match order` | Prevents information leakage: returns minimized response when confirmation does not match order |
| `GET /shopify/extension/order-status returns full response with amounts and tx_hash when confirmation matches order` | Returns complete response (amounts, pay URL, tx hash) when caller proves order binding via confirmation parameter |
| `order-status rebuilds partial paidUsd and remainingUsd from recovered Openrail checkout after server restart` | Rebuilds partial payment numbers from Openrail checkout entity on cache miss / restart in order-status |
| `orders/create rebuilds partial paidUsd and remainingUsd from recovered Openrail checkout after server restart` | Rebuilds partial payment numbers from Openrail checkout entity on cache miss / restart in orders/create |
| `Thank-You extension extracts confirmationNumber from orderConfirmation and passes confirmation query param` | Verifies Thank You Preact extension retrieves orderConfirmation.value.number and appends &confirmation= to status query |
| `builds view model for error state with warning tone and no controls` | Verifies ThankYouModel output for error state: warning tone, Payment status unavailable heading, reload/contact text, zero controls |
| `parseOrderStatusResponse returns not_openrail for 404 with error code not_openrail_order` | Confirms not_openrail_order 404 cleanly classifies as not_openrail (renders null) |
| `parseOrderStatusResponse returns not_openrail for 404 with error code order_not_found` | Confirms order_not_found 404 cleanly classifies as not_openrail (renders null) |
| `parseOrderStatusResponse returns failure 404 when 404 body is HTML or lacks openrail error code` | Confirms proxy or unknown 404 without openrail error code classifies as failure (renders warning banner) |
| `parseOrderStatusResponse returns failure for 401 Unauthorized` | Confirms 401 classifies as failure (renders warning banner) |
| `parseOrderStatusResponse returns failure for 403 Forbidden` | Confirms 403 classifies as failure (renders warning banner) |
| `parseOrderStatusResponse returns failure for 429 Too Many Requests` | Confirms 429 classifies as failure (renders warning banner) |
| `parseOrderStatusResponse returns failure for 500 / 502 / 503 Server Error` | Confirms server errors classify as failure (renders warning banner) |
| `parseOrderStatusResponse returns failure for unparsable or malformed body on ok response` | Confirms malformed response bodies classify as unparsable_body failure |
| `parseOrderStatusResponse returns failure for network error (null response)` | Confirms fetch network failure classifies as network_error failure |
| `stepPollState immediately shows error banner on initial failure when no good state exists` | Verifies immediate transition to error banner on initial failure when no prior good state exists |
| `stepPollState keeps last good state during 1 or 2 transient failures during polling` | Verifies transient glitches (1 or 2 failures) retain existing unpaid/partial/paid view without showing error banner |
| `stepPollState transitions to error banner on third consecutive failure during polling` | Verifies transition to warning banner upon 3 consecutive failures during polling |
| `stepPollState recovers to good state when a poll succeeds after transient failures` | Verifies recovery from failures when a poll succeeds, resetting failure count to 0 |
| `stepPollState renders null and stops tracking on not_openrail response` | Verifies not_openrail clears state and renders null |
| `GET /shopify/extension/pay-link accepts OrderIdentity GID and normalises to Order GID for Admin API` | Verifies pay-link accepts `gid://shopify/OrderIdentity/<n>` from Thank-You extension and queries Admin API with `gid://shopify/Order/<n>` |
| `GET /shopify/extension/order-status accepts OrderIdentity GID and normalises to Order GID for Admin API` | Verifies order-status accepts `gid://shopify/OrderIdentity/<n>` and returns normalized `gid://shopify/Order/<n>` |
| `GET /shopify/extension/pay-link accepts bare numeric order id and normalises to Order GID` | Verifies pay-link accepts bare numeric strings `<n>` and converts to `gid://shopify/Order/<n>` |
| `GET /shopify/extension/order-status accepts bare numeric order id and normalises to Order GID` | Verifies order-status accepts bare numeric strings `<n>` and converts to `gid://shopify/Order/<n>` |
| `GET /shopify/extension/order-status rejects invalid order id formats with 400` | Rejects non-numeric strings and invalid GID types (e.g. `Customer`) on order-status with HTTP 400 `invalid_request` |
| `connector logs session token refusal at most once per minute with reason only` | Throttles session token refusal warnings to at most once per 60s per reason, never logging the token |
| `creates binding from webhook payload, allowing pay-link and order-status to work without Admin API getOrder` | Verifies full pay-link and order-status flows operate from webhook binding without calling Admin API getOrder |
| `the race: order-status returns 202 order_pending before webhook arrives (within 2 min), then 200 after webhook` | Handles race condition where Thank-You page polls before webhook delivery, returning 202 without error banner |
| `the race timeout: order-status returns 404 order_not_found after 2 minutes without binding` | After 120s without webhook arrival, transitions from 202 order_pending to 404 order_not_found |
| `order-status returns 404 not_openrail_order when webhook recorded non-Openrail gateway` | Ensures non-Openrail gateway reported in orders/create causes extension to return 404 not_openrail_order |
| `orders/create webhook validates currency and total amount` | Refuses non-USD currencies with 422 and zero or negative totals with 400 |
| `marking paid logs protected customer data message, does not crash, and buyer sees paid` | On orderMarkAsPaid protected customer data refusal, logs warning, keeps binding paid, and shows paid to buyer |
| `ThankYouModel parses 202 response and builds non-error view model for order_pending` | Verifies ThankYouModel correctly handles HTTP 202 status returning visible, quiet state without error banner |
| `normalises SHOPIFY_SHOP_DOMAIN in loadShopifyAppEnv and rejects invalid host with INVALID_ENV: SHOPIFY_SHOP_DOMAIN` | Strips scheme (`https://`/`http://`), path, query/hash, trims and lowercases bare host; rejects invalid host values with `INVALID_ENV: SHOPIFY_SHOP_DOMAIN` without leaking input values |
| `webhook refused invalid signature logs one line [shopify] webhook refused: invalid signature without body or headers` | Logs clean operator diagnostic `[shopify] webhook refused: invalid signature` with zero body or header leakage |
| `webhook accepted for Openrail order logs one line [shopify] order <numeric id> bound from webhook (total <usd>)` | Confirms store-admin `orders/create` webhook binding arrived and registered in `journalctl` |

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

## 10. Troubleshooting & Operator Diagnostics Reference

When inspecting service logs (`journalctl -u openrail-shopify`), check these log signatures:

| Service Log Line | What It Means & How to Fix |
|---|---|
| `[shopify] session token refused: wrong_shop token dest unreadable ...` | The Thank-You / Checkout UI extension session token did not provide a readable `dest` claim host. Ensure extension was built with modern Shopify CLI. |
| `[shopify] session token refused: wrong_shop token shop X, configured Y` | The store domain in the extension's session token (`X`) does not match the configured `SHOPIFY_SHOP_DOMAIN` (`Y`). Check `/etc/openrail/shopify.env` and ensure `SHOPIFY_SHOP_DOMAIN` is set to the bare host matching the store. |
| `[shopify] session token refused: wrong_app ...` | The audience (`aud`) in the session token does not match `SHOPIFY_CLIENT_ID`. Verify `SHOPIFY_CLIENT_ID` in `/etc/openrail/shopify.env` matches Dev Dashboard. |
| `[shopify] session token refused: bad_signature` | The session token HMAC could not be verified using `SHOPIFY_CLIENT_SECRET`. Verify client secret in `/etc/openrail/shopify.env`. |
| `[shopify] webhook refused: invalid signature` | Shopify's `orders/create` webhook signature check failed. The signing secret configured in `SHOPIFY_WEBHOOK_SECRET` does not match the store webhook signing key (Shopify Admin → Settings → Notifications → Webhooks). No body or header values are leaked. |
| `[shopify] order <numeric id> bound from webhook (total <usd>)` | Confirms Shopify's store-admin `orders/create` webhook arrived, HMAC signature was verified, and the order binding was registered in memory. |
| `[shopify] cannot mark order <id> paid: the app is not approved for protected customer data...` | Expected warning when Level 1 Protected Customer Data approval has not yet been granted. The connector suppresses the error, keeps the internal binding marked `paid`, and presents the paid receipt to the buyer. |

