# Limitations

Status: **built** facts unless marked **exploring**.

- Openrail covers money in only. It is not payroll, bulk payments or treasury.
  **built**
- No fiat on- or off-ramps. **built**
- No credit decisions, lender pools, marketplace or borrowing against invoices.
  **built**
- No custody: service accounts hold gas only; the API holds no NEAR key. **built**
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
