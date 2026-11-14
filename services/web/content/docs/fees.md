# Fees and storage

What a payment costs, who pays it, and how invoices pay for their storage on NEAR.

## The protocol fee

The contract takes **0.25% (25 basis points)** of every booked payment. There is no monthly fee. The business chooses who pays it:

| Setting            | What the client pays                              | What the business receives |
| ------------------ | ------------------------------------------------- | -------------------------- |
| `absorb` (default) | The invoice amount                                | The amount less 0.25%      |
| `pass_to_customer` | The subtotal plus a line `Processing fee (0.25%)` | About the subtotal         |

With `pass_to_customer`, the fee is rounded **up** to a whole cent: `fee_cents = ceil(subtotal_cents × 25 / 10000)`. For a $12.00 subtotal the fee is 3 cents and the client pays $12.03; the contract takes 30,075 micro-USDC and leaves $11.999925, within a cent of the subtotal.

`GET /v1/fee_preview?subtotal_usd=12.00` returns the fee, the total and what the business receives, for the business's setting.

## Swap costs

The client's coin and chain decide the swap cost, which NEAR Intents shows in the quote **before** the client pays.

- USDC to USDC routes measured a **0% spread**.
- ETH and SOL quotes include a price-protection margin of up to 1%; the unused part is kept by the provider, not refunded. The pay page says "you pay up to X".
- A cash-out shows its cost before you sign.

## Storage credit

Each invoice stores about **1.6 KB** on NEAR (1,595 bytes measured at the 5,000th claim). Creating one costs **0.02 NEAR** of storage, taken from:

1. the business's **prepaid storage credit**, deposited with `deposit_storage_credit` (Settings shows the balance and a deposit button); or, if that is empty,
2. the **sponsor pool**, which anyone can fund (`deposit_sponsor_pool`), up to a cap of sponsored invoices per business.

A business with no credit can therefore still create invoices while the pool lasts. `GET /v1/business/storage_credit` shows the credit and the pool's state.

## Gas

Bookings, payouts and lock clears are NEAR transactions paid by Openrail's service accounts. Measured costs (sandbox, at claim 1 and claim 5,000):

| Call                        | Gas                 |
| --------------------------- | ------------------- |
| `issue`                     | 15.30 to 15.46 Tgas |
| `reconcile`, nothing new    | 6.86 Tgas           |
| `reconcile`, payment booked | 17.97 to 18.25 Tgas |
| `nft_transfer`              | 3.54 to 3.62 Tgas   |
