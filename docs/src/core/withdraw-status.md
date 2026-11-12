# Confidential withdrawal status words

`GET /v1/balance/confidential/withdraw/status?deposit_address=...` returns the provider's `status`
word unchanged, plus:

- `phase`: `pending`, `processing`, `success`, `refunded` or `failed`
- `terminal`: `true` only for an end state

The web poller must use this list, not guess from a missing word.

| Provider word | Phase | Terminal | What the UI does |
| --- | --- | --- | --- |
| `SUCCESS` | `success` | **yes** | end: show the destination transfer |
| `REFUNDED` | `refunded` | **yes** | end: the money returned to the private balance |
| `FAILED` | `failed` | **yes** | end: show the failure and keep the balance |
| `PENDING_DEPOSIT` | `pending` | no | keep polling |
| `INCOMPLETE_DEPOSIT` | `pending` | no | keep polling: more of the deposit can still arrive |
| `KNOWN_DEPOSIT_TX` | `processing` | no | keep polling: the deposit transaction is known |
| `PROCESSING` | `processing` | no | keep polling |
| any unknown word | `pending` | no | keep polling; log it, do not end |

`INCOMPLETE_DEPOSIT` is **not** an end state. The old page ended "It did not complete" on it; the
correct behaviour is to keep following until `SUCCESS`, `REFUNDED` or `FAILED`.

The provider's own copy of the status is under `swapDetails` in the raw response used by the API;
the route above is the one the web calls.
