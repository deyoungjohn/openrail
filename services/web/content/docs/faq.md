# FAQ

Short answers to the questions people ask first.

## Who holds the money?

Nobody but the business. A payment lands in the invoice's own keyless account and the contract moves it only to the invoice's owner, on `intents.near`. Openrail's services hold NEAR for gas, never your funds. See [One account per invoice](/docs/invoice-accounts).

## Which chains and coins can clients pay with?

USDC and USDT from NEAR, Base, Arbitrum, Ethereum, Solana, Polygon, Optimism and BNB Chain, plus ETH, SOL and NEAR. The business receives USDC.

## What does it cost?

0.25% per booked payment, paid by the business or passed to the client. No monthly fee. The swap cost of the client's route is shown before they pay. See [Fees and storage](/docs/fees).

## How fast is it?

About 30 seconds from the provider's success to the booking (the median on mainnet). USDT and longer routes take a minute or more.

## How do I know a payment is real?

Every booking is a transaction of `openrail.near` on NEAR mainnet. Each receipt links the payer's transaction and the booking, and prints a command that checks them. See [Verify a payment](/docs/verify).

## Can I keep my balance private?

Yes. Turn on the [confidential balance](/docs/confidential-balance) and payments move into NEAR Intents' confidential balance, which only you can see. The bookings themselves stay public.

## Does it work with my store?

There is a [Shopify](/docs/shopify) app and a [WooCommerce](/docs/woocommerce) plugin, both proven on real stores. Any other store creates a [checkout](/docs/checkout) with one API call and gets a signed webhook when it is paid.

## Do my clients need an account?

No. They open a link, pick a coin and a chain, and pay from a wallet or an exchange.

## Can an AI agent use it?

Yes. The [MCP server](/docs/agents) lets an agent check payments, fetch receipts, send pay links and prepare invoices. It holds no keys; you sign.

## What happens if Openrail goes down?

Payments wait to be booked; none are lost. Anyone can book a payment with the permissionless `reconcile`, and the money stays in the invoice's account until then.

## Is it trustless?

Not yet. The contract can be upgraded by its root key until that key is removed or time-locked. See the [Trust model](/docs/trust).
