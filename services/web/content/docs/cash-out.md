# Cash out

Move USDC from your balance on NEAR Intents to an address on the chain you choose, in one signature.

## In the app

1. Open **Payout → Public → Withdraw**.
2. **Take it from**: the token to spend (for example _NEAR USDC · $148.11_). _Available to cash out now_ shows its balance.
3. **Amount**: type it or use the slider (25%, 50%, 75%, 100% of that token).
4. **Send to**: the network, then the **Address** that receives the money. Check it twice: a cash-out cannot be undone.
5. **Get quote** shows what it costs and what arrives. Then sign once in your NEAR wallet.

**Where your money is** then follows it: _Leaves your balance_, _Received by the bridge_, _Sent to <network>_, _Arrived at your address_, with explorer links. **Stats** shows revenue, cashed out and not cashed out yet, and every cash-out.

## Destinations

USDC on NEAR, Base, Arbitrum, Ethereum, Optimism, Polygon, BNB Chain or Solana, where NEAR Intents can quote the route. The quote fails cleanly (nothing is charged) when a route is not available.

## Over the API

```bash curl
curl -s -X POST "$API/v1/cashout/quote" \
  -H "Authorization: Bearer $OPENRAIL_SECRET_KEY" \
  -H "content-type: application/json" \
  -d '{"amount":"100000000","destination_chain":"base","address":"0xYourAddress","source_asset":"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"}'
```

The answer (`201`) has the route cost, the provider deposit address and the cash-out `id`; your wallet signs the transfer to that address. **Openrail never signs it**: the CLI and the API only prepare it. After you send it, `POST /v1/cashouts/{id}/sent` attaches your transaction hash, and `GET /v1/cashouts/{id}` follows it to the end.

## Statuses

`quoted`, `sent`, `processing`, `success`, `refunded`, `incomplete` (a short deposit waiting for the rest) and `failed`. A refunded or failed cash-out leaves the money in your balance. The provider is asked about a cash-out for 14 days.

## Confidential

To withdraw from the confidential balance instead, use **Payout → Confidential → Withdraw**. See [Confidential balance](/docs/confidential-balance#withdraw).
