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
