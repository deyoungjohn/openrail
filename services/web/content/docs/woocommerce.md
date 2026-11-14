# WooCommerce

The Openrail plugin makes stablecoins a payment method in WooCommerce: the buyer chooses it at checkout, pays on the hosted page, and the order completes from a signed webhook.

> [!NOTE]
> Proven on a real store: [belmonte.incepture.dev](https://belmonte.incepture.dev), open to anyone, took a $48.50 order paid in USDC on Arbitrum. The order completed on its own and its page says _Your payment is confirmed on NEAR_. See [Use cases](/use-cases#woocommerce).

## How it works

1. At checkout the buyer chooses **Pay with stablecoins**. It works with the classic checkout and with WooCommerce Blocks.
2. The plugin creates **one** Openrail checkout for the order total (never an amount from the request), with the idempotency key `wc-<order id>`, and sends the buyer to `pay_url`.
3. The buyer pays. Openrail books it and sends the plugin a signed `checkout.paid`.
4. The plugin verifies the signature and the amount, and completes the order once. The order page shows the live status from `GET /v1/checkouts/{id}`.

## Install

1. Upload the plugin zip (Plugins → Add New → Upload) and activate it.
2. In Openrail **API Integration**, create a secret key with `invoices:read` and `invoices:write`, and add the webhook endpoint `https://<your store>/wp-json/openrail/v1/webhook` for the checkout events. Copy its signing secret.
3. In WooCommerce → Settings → Payments → Openrail, paste the API key and the webhook secret, and enable the method. The store currency must be **USD**.

Secrets are never shown again in the settings page: leaving the field blank keeps the saved value.

## Order states

| Event                                 | Order                                         |
| ------------------------------------- | --------------------------------------------- |
| `checkout.paid` at the full total     | Completed (once, even if the event repeats)   |
| `checkout.paid` below the total       | Left pending                                  |
| `checkout.partial`                    | On hold, with the amounts in a note           |
| `checkout.paid_late`                  | On hold, with a note to review it in Openrail |
| `checkout.accepted` at the full total | Completed                                     |
| `checkout.refund_started`             | Note with the refund amount and destination   |

A webhook with a bad signature, or a timestamp more than 5 minutes off, is refused with `401` and changes nothing.

## Limits

- Installed from a zip; not in the WordPress.org directory yet.
- USD stores only.
- Partial and late payments put the order on hold for the merchant to review instead of completing it.
