# How a payment works

From a pay link to USDC in the business's account, step by step, and who does what at each step.

## The five steps

1. **The business asks to be paid.** It creates an invoice or a checkout. The Openrail contract mints it as an NFT and creates a keyless account for it on NEAR, named after the business and the invoice.
2. **The client gets a price.** On the hosted pay page the client picks a coin and a chain. The API asks NEAR Intents (through its 1Click service) for an exact quote whose output is USDC sent to the invoice's account on `intents.near`. The quote comes with a one-time deposit address and a deadline.
3. **The client pays.** From a connected wallet (EVM, Solana or NEAR) or by sending from an exchange to the deposit address. NEAR Intents swaps on the way. The pay page follows the provider's status.
4. **The contract books it.** When the money reaches the invoice's account, `reconcile` books it: the claim's status moves to `PartiallyPaid` or `Paid`, the 0.25% fee is taken, an event is written, and the business's share is credited to its owner on `intents.near`. The watcher calls `reconcile` as soon as the provider reports the deposit; anyone else may call it too.
5. **The business is paid out.** The share is held for the owner, then sent on the owner's schedule to the destination they chose: USDC on a chain, or the [confidential balance](/docs/confidential-balance).

## Timing

On mainnet the median time from a provider's success to the booking was **30.5 seconds** over timed checkouts. USDT and longer routes can take a minute or more, because the swap itself takes longer. A booking never depends on Openrail's services being up: `reconcile` is permissionless.

## Who touches the money

| Step              | Who acts                                      | What they can do                                                                          |
| ----------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Quote and deposit | NEAR Intents (1Click)                         | Deliver the quoted USDC to the invoice's account, or refund the payer                     |
| Booking           | The contract, called by the watcher or anyone | Book what is on the invoice's account; nothing else                                       |
| Payout            | The payout worker                             | Ask for a quote whose recipient is the owner's registered destination, and send only that |
| Withdrawal        | The business, in its own wallet               | Move its own balance on `intents.near`                                                    |

No Openrail service holds the business's money. Service accounts hold NEAR for gas only, and the API holds no NEAR key at all. See the [Trust model](/docs/trust).

## Partial, split and late payments

- **Partial.** A payment below the amount due moves the invoice to `PartiallyPaid`; the rest can follow on any chain.
- **Split.** The pay page can split one invoice over several chains and coins; each part gets its own price.
- **Late.** A checkout paid after it expired is booked as late and held; the merchant accepts it or refunds it. A payment to an invoice already closed is refunded to the payer.

## What the client sees

The client never creates an account. They see the amount, the coin and chain they chose, the exact price (locked until a deadline), the deposit address and its QR code, and live progress: _You send_, _Payment received_, _Paid out to the business_. When it is booked, the page shows the receipt with explorer links.
