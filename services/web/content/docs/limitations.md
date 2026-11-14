# Limitations

What this build does not do, or does with limits. Stated plainly so nothing here is a surprise.

## Scope

- Openrail covers **money in** only: invoices and checkouts. It does not pay people out in bulk or manage a treasury.
- No fiat on- or off-ramps. Only **USD** invoices and checkouts.
- No credit decisions, lending against invoices or marketplace.
- Bitcoin and Tron payments are not supported. Native ETH and SOL are accepted only on the pay link.
- Smart-contract wallet acknowledgement (EIP-1271) is not supported.

## Trust

- The contract can be upgraded by its root key; until that key is removed or time-locked, Openrail is not trustless.
- The wasm is not built reproducibly yet.
- The `intents.near` verifier is an external dependency, not audited by Openrail.
- The legal effect of the invoice clauses is untested.

## Behaviour

- **Invoice webhooks.** The `invoice.*` event names are listed but not yet mapped from the contract's events, so they are not delivered. Checkout webhooks are delivered. Follow invoices with the API meanwhile.
- **Detection.** Payments are noticed through the provider's status. A transfer sent by hand to a claim account is booked by the daily sweep (within 24 hours) or at once by anyone calling `reconcile`.
- **Timing.** Bookings take about 30 seconds after the provider's success; USDT and long routes take a minute or more. The provider sometimes refuses a quote for a route; the payer picks another coin or chain.
- **Confidential balance.** Its read session lives in the API's memory (sign again after a restart), and withdrawals are listed from the time they were made on this site.
- **Invoice acceptance** is in the contract but has no page: clients pay without accepting first.
- **Client data.** The client's address and the line items are kept off chain with the invoice; the line items' hash is in the terms, the address is not.
- **Listing by issuer** scans claim numbers: at 5,000 claims a full scan for an issuer with none costs 540.66 Tgas, more than one call carries. A per-issuer index is designed, not built.

## Stores

- **Shopify**: not a native gateway (needs Payments Partner approval); orders are not marked Paid in Shopify until protected customer data access is granted; buyer names show as "Store customer".
- **WooCommerce**: installed from a zip, not the WordPress.org directory; partial and late payments go on hold for review.

## Operations

- Each booking, payout and lock clear is a NEAR transaction paid by a service account; refused calls back off up to six hours so they cannot drain it.
- Storage for new invoices comes from the business's credit or a sponsor pool funded by the operator; when the pool is empty, a business without credit must deposit some.
