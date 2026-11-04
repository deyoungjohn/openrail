# Design: per-issuer claim index

Status: **exploring**. Design only; no code. This is an H-phase item. The
contract is frozen for the G1 deploy and does not contain this index.

## Problem

`claims_by_issuer(account, from, limit)` walks claim numbers from `from` up to
`next_token_id` and returns the first `limit` claims whose issuer is `account`.
The cost depends on how many claims it has to look at, not on how many it
returns. At 5,000 claims a full scan for an issuer with no matching claims
burned 540.66 Tgas, against 15.41 Tgas for a page of 50 matches near the end.
Figures, method and the seeding caveat are in
[`evidence/gate-g1-2026-11-04.md`](../../../evidence/gate-g1-2026-11-04.md).
A view call is capped well below the full-scan figure, so a sparse issuer
cannot be listed at that size.

## Goal

`claims_by_issuer` costs O(`limit`) reads whatever the total claim count and
whatever the issuer's share of it.

## Storage keys

One append-only list per issuer, written once when a claim is issued. The
issuer of a claim never changes after issuance (ownership moves, issuer does
not), so there is no removal and no swap-remove.

| Key                             | Value                                                            |
| ------------------------------- | ---------------------------------------------------------------- |
| `ii:<issuer>:n`                 | `u64` count of claims issued by `<issuer>`                       |
| `ii:<issuer>:i:<idx as u64 LE>` | `u64` claim number `n` (token id `c-<n>`) for `0 <= idx < count` |

- `<issuer>` is the account id bytes, as in the existing owner index prefix.
- The prefix `ii:` is new and must not collide with `i`-prefixed keys already
  in use (`c:`, `t:`, `a:`, `w:`, `l:`, `lc:`, `qd:`, `u:`, `s:`, `o:`, `ti:`,
  `cfg`). Because `<issuer>` is followed by `:`, an account id cannot be
  confused with a longer one.
- Entries are strictly increasing in claim number, because claim numbers come
  from a counter and each entry is appended at issue time.
- Cost: two writes per issue (list entry and count), about 40 bytes of
  storage per claim plus the issuer id on the first entry. This is added to the
  per-claim storage and issue gas in
  [`COSTS.md`](COSTS.md) when the index ships.

## Cursor

Two options were considered.

1. **Ordinal cursor (recommended).** `from` is a 0-based position in the
   issuer's own list. The view reads `count`, then entries
   `from .. min(from + limit, count)`, then the claim for each. Cost is
   O(`limit`) reads. The next cursor is `from + page.len()`. This is the same
   shape as `payment_log` and `nft_tokens_for_owner`, so every paginated view
   has one cursor meaning.
2. **Claim-number cursor.** Keep `from` as a claim number and binary-search
   the list for the first entry `>= from`. Cost is O(log count + `limit`).
   It keeps today's meaning of `from` but adds code for no caller that needs it.

Choose option 1. The meaning of `from` changes, so the change is a new view
version, not a silent edit (see Migration).

An issuer with no claims returns an empty page after one read. `limit` keeps
its current cap.

## Watcher change

`services/watcher/src/watcher.ts` pages `claims_by_issuer` in `discoverClaims`
and derives the next cursor with `nextIssuerFrom`, which parses the highest
`c-<n>` in the page and continues from `n + 1`.

With the ordinal cursor:

- the first page starts at `from = 0` instead of `1`;
- the next cursor is `from += page.length`, as `lastQuoteDeadline` already does
  for `payment_log`;
- `nextIssuerFrom` and its token-id parsing are removed;
- the stop rule is unchanged: a page shorter than the page size ends the loop.

The watcher and the contract must agree on the cursor before either ships.
A watcher that starts at `from = 1` against the new view would skip the first
claim of every issuer, and an old watcher would skip claims as well, so the two
are released together.

## Migration

The index is empty on a contract deployed without it, so claims issued before
the upgrade are missing from it. Options:

- **Backfill by an owner-gated, paged method** that walks claim numbers in
  bounded batches and appends entries in claim-number order. It is run to
  completion before the new view is enabled, and is idempotent through a
  stored high-water mark.
- **Redeploy** with a fresh contract if the claim count at upgrade time is
  small.

Until the backfill is complete the view must not be switched, because a partial
list looks like a complete one.

## Tests to add with the code

- Issue claims from two issuers interleaved; each issuer's list is complete,
  in order, with no entries from the other.
- Paging across a page boundary returns each claim once.
- An issuer with no claims returns an empty page with gas independent of the
  total claim count (extend the 5,000-claim scale test).
- Transfer a claim; it stays in its original issuer's list.
- Backfill: partial run, rerun, and completion give the same list as native
  issuance.
- Watcher test: discovery over more than one page, using the ordinal cursor.

## Open questions

- Is a view version bump acceptable to the indexer and the API, or should the
  new method get a new name and the old one be deprecated?
- Backfill or redeploy, decided by the claim count when the upgrade is planned.
