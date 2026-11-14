# Security

How Openrail protects money, keys and webhooks, and how it was checked.

## Money

- **Keyless invoice accounts** obey only the contract; the contract pays only the claim's owner.
- **Monotonic booking**: a balance rise is booked once; a second `reconcile` books nothing new.
- **Locks** block transfers while a booking is in flight; a lock has a deadline and a stale one can be cleared.
- **Callbacks check every promise result**; private callbacks can only be called by the contract itself.
- **Exactly 1 yoctoNEAR** is required for NFT mutations, so a function-call key cannot transfer a claim.
- **The payout worker checks the recipient** of every quote against the owner's registered destination before sending.

## Keys and sessions

- Secret API keys are shown once and stored only as SHA-256 hashes; they are scoped and can be rotated or revoked.
- Dashboard sign-in is a NEP-413 signed message checked against the account's access keys on chain (an unfunded implicit account signs with its own key). Sessions are HttpOnly cookies, hashed at rest, 7 days sliding, capped at 30.
- Cookie-authenticated writes pass CSRF checks on the origin and content type.
- Secrets are read only from the environment; they are never logged, printed or committed. A secret scan runs in CI.

## Webhooks

- Signed with HMAC-SHA256 over `timestamp.body`, with a 5-minute tolerance; verify the raw body.
- Built only from indexed events, so a delivery cannot describe something that did not happen on chain.
- Webhook URLs are checked before delivery (no private or local addresses).

## How it was checked

- **Security review** against the build's checklist: forward-receiver allow-list, private callbacks, monotonic balances, bounded locks, no information in panic messages, scoped roles, 1 yocto deposits, storage refunds. Each item has a written resolution in the repository (`docs/src/core/security-review.md`).
- **Mutation testing**: each contract rule was broken on purpose and a named test had to fail (`docs/src/core/mutations.md`).
- **Leak check**: switched-off modules leave no trace in the build.

## Report a problem

Open a security advisory on [GitHub](https://github.com/deyoungjohn/openrail/security) rather than a public issue.
