# Confidential balance

Payments can move into a balance on NEAR Intents that only the business can see, then leave it to any supported chain.

## What it is

NEAR Intents offers confidential balances: amounts held there are not shown on the public chain. Openrail can send each held payment into the business's own confidential balance instead of a public address. The business still owns it outright; it is only hidden from public view.

> [!NOTE]
> The bookings themselves stay public: the contract's events show each payment to each invoice. What becomes confidential is the business's balance and its withdrawals afterwards.

## Turn it on

In **Settings → Payouts → Confidential balance**, choose **Turn on** and sign once in your wallet. From then on, held payments of $1 or more move into the confidential balance on your schedule. The payout worker asks for a shield quote with the same asset on both sides, so nothing is swapped on the way in.

## See it

Reading a confidential balance needs proof that you are its owner. On **Payout → Confidential**, choose **Show my balance** and sign one message (an empty intent with a versioned nonce). The API keeps that session for a short time; the browser never holds the provider's token.

The balance can hold USDC from several chains (for example SOL USDC and BASE USDC), because each payment moves in as the USDC it settled in.

## Withdraw

1. Choose **Take it from** (for example _SOL USDC · $34.91_). The amount and slider work against that token's balance.
2. Enter the amount, pick a network and a wallet address.
3. Get the price, then **Withdraw** and sign the one message the wallet shows.
4. The first time, the wallet's key is registered once with the intents contract (a tiny transaction); then the withdrawal is sent.

The card follows the provider's status until it is final and shows the destination transaction.

## Limits

- The session to read the balance lives in the API's memory; after a restart you sign again.
- Withdrawals are listed from the time they were made on this site.
- A withdrawal that fails stays in the confidential balance; nothing is lost.
