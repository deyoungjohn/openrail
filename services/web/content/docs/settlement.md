# Settlement and payouts

What happens to the business's share after a payment is booked: where it is held, when it moves, and how it reaches the business.

## Held for the owner

When `reconcile` books a payment, the business's share (the payment less the 0.25% fee) is credited to the claim's owner on `intents.near`, the NEAR Intents contract. It is the owner's balance: Openrail cannot spend it. The **Payout** page shows it and what it is made of (for example _NEAR USDC · $48.38_).

## Payout destination and schedule

In **Settings → Payouts** the business chooses:

- **Where held payments go**: USDC on a chain they choose, or their [confidential balance](/docs/confidential-balance).
- **When**: after each payment, once a day, once a week or once a month. Payments under $1 are kept until they add up.

The destination is registered on the contract (`set_settlement`). The payout worker reads it there, never from the API.

## The payout worker

For each held share the worker:

1. asks NEAR Intents for an exact-input quote, with a refund back to the claim account;
2. checks the quote's recipient equals the owner's registered destination **before** sending anything;
3. calls `settle_payout` on the contract with the deposit address;
4. follows the provider's status until it is final;
5. reports the outcome with `report_payout`: settled with the destination transaction, or refunded with the amount.

A restart is safe: a payout already in flight is only followed and reported, never sent twice. A call the contract refuses is retried with a growing wait (from minutes up to six hours), so a stuck payout cannot drain the worker's gas account.

## Cash out by hand

The business can also move its balance any time from **Payout → Withdraw**: choose the token to take it from, an amount (with a slider up to the full balance), a network and an address, see the cost, and sign once. See [Cash out](/docs/cash-out).

## Where the money is

The Payout page's **Stats** follows every share: _Held_, _On its way_, _In your confidential balance_, _Returned_, and each withdrawal, with explorer links for each step.
