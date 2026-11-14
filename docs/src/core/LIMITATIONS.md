# Limitations

Status: **built** facts unless marked **exploring**.

- Openrail covers money in only. It is not payroll, bulk payments or treasury.
  **built**
- No fiat on- or off-ramps. **built**
- No credit decisions, lender pools, marketplace or borrowing against invoices.
  **built**
- No operator custody: service accounts hold gas only; the API holds no NEAR key. **built**
- A payment sits in the invoice's claim account (a keyless vault under the Openrail
  contract) and moves only as the contract's code allows, to the invoice's owner.
  The claim account's name does not say who owns the invoice: the owner is
  `owner_id` in the contract state, which is also the owner of the invoice's NFT.
  The vault can only be moved by the account that created it, so claim accounts are
  created by the contract and not under a business's own account. **built**
- The contract can be upgraded by its root key. Until that key is removed or put
  behind a time lock, Openrail is not trustless, and this page does not claim
  it is. **built**
- No legal filing or dunning; the legal layer is clause text plus document
  hashes. **built**
- Bitcoin and Tron payments are not supported. **built**
- BNB Chain payouts are not supported (the route is not quotable). **built**
- Native ETH or SOL is accepted only on the pay link. **built**
- Only USD invoices are supported. **built**
- Smart-contract-wallet acknowledgement (EIP-1271) is not supported. **built**
- The legal effect of the clauses is untested; counsel is needed. **exploring**
- The `intents.near` verifier is an external dependency and is not independently
  audited by Openrail. **exploring**
- The issuer service is a separate process; without it the real API can create
  invoices only through the mock path. **built**
- The SQLite invoice/payment cache is an interim boundary; receipts, statements
  and events already read from the indexer. **built**
- A watcher outage delays bookings; it does not lose funds. **built**
- `claims_by_issuer` scans claim numbers, so its cost grows with the total
  number of claims, not with the number returned. At 5,000 claims, a page of 50
  matching claims cost 15.41 Tgas, but a full scan for an issuer with no claims
  cost 540.66 Tgas, which is more than a single call can carry. Listing a
  sparse issuer is therefore not safe at that size. The contract is frozen for
  the G1 deploy; a per-issuer index is planned for a later phase
  ([`design-issuer-index.md`](design-issuer-index.md)). The watcher is not
  affected at today's claim counts. Figures: [`evidence/gate-g1-2026-11-04.md`](../../../evidence/gate-g1-2026-11-04.md). The claims between the
  sample points in that run were seeded directly into contract state; the
  sample points are real transactions. **built**
- Payments are detected through the provider's status, not by polling the chain. The API asks
  the provider about each live deposit address every 5 s, until an hour after its deadline,
  and tells the watcher when money moves; the watcher then reads that one claim and books what
  is on its account. A transfer that bypasses the provider (sent by hand to a claim account) is
  booked by the daily sweep, so within 24 h, or at once by anyone calling the permissionless
  `reconcile`. **built**
- The provider's status endpoint has no published rate limit. If it refuses, the API pauses
  for one minute, and the payer's page keeps asking on its own. **built**
- A payment's chain in the dashboard is the chain of the client's pay session. A payment
  without a pay session (sent by hand) shows the chain its money settled on. **built**
- The private balance is read from the provider after the business signs once with its
  wallet. The session lives in the API's memory: after a restart the business signs again.
  **built**
- Withdrawals from the private balance are listed from the moment they were recorded here
  (13 Nov 2026). An earlier withdrawal is added by its deposit address. **built**
- Each payout, booking and lock clear is a NEAR transaction paid by a service account. A call
  the contract refuses is retried with a growing wait (2 to 5 minutes, doubling to 6 hours), so
  a stuck payout cannot drain the account. **built**
- Invoice acceptance (the client signing the invoice) is in the contract but has no page:
  clients pay without accepting first, as on common invoicing tools. **built**
- The client's address and the line items are kept with the invoice, off chain. They are not
  part of the terms fingerprint. **built**
