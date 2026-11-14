# One account per invoice

Every invoice and every checkout gets its own account on NEAR. That one decision is why matching is exact, why the address cannot be swapped, and why the money is never held by Openrail.

## The claim and its account

When an invoice is issued, the contract `openrail.near` does three things in one transaction:

- records a **claim**: the terms, the amount due, the due date, the owner and a fingerprint of the terms;
- mints the claim as an **NFT** (NEP-171) to the business;
- creates a **keyless account** for it, `<business>-<ref>.openrail.near`, where `<business>` is the business's username made URL-safe and `<ref>` is the first 12 hex characters of the invoice reference. Older claims use `c-<n>.openrail.near`.

The token id is the label, so `claim(<label>)`, `nft_token(<label>)` and the account name always agree. A later username change does not rename an old account: its name on chain is fixed for ever.

## Why keyless matters

The account has no access keys. Nobody can sign for it: not the business, not Openrail. It obeys only the Openrail contract, which moves what lands there under its rules, to the claim's owner.

- **Exact matching.** A credit to that account is a payment of that invoice. There is no memo to forget and no amount to guess.
- **No address fraud.** The account is fixed in the terms the client sees. An email saying "we changed our account" cannot change where the contract sends the money.
- **No custody.** The money sits in the invoice's own account, then goes to its owner. Openrail never holds it.

## Lifecycle

| Status          | Meaning                               |
| --------------- | ------------------------------------- |
| `Issued`        | Created, nothing paid yet             |
| `PartiallyPaid` | Some of the amount due is booked      |
| `Paid`          | The amount due is booked              |
| `Cancelled`     | The owner cancelled it before payment |
| `Closed`        | Finished; a later payment is refunded |

While money is moving, a **lock** blocks transfers of the claim, so ownership cannot change in the middle of a booking.

## The NFT is the right to be paid

Whoever holds the claim's NFT is paid. Transferring it re-routes every later payment, for example when collections are handed to someone else. Transfers follow numbered rules in the contract (no transfer while a booking is in flight, approvals cleared on transfer, a 1 yoctoNEAR deposit), and a refusal names the rule.

## Storage

Creating a claim stores about 1.6 KB on NEAR. It is paid from the business's prepaid storage credit (0.02 NEAR per invoice), or from a shared sponsor pool when the business has none. See [Fees and storage](/docs/fees).
