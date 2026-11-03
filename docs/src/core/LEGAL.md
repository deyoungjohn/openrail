# Legal layer

Status: **built** for the text and hashes; **exploring** for enforceability.

Each invoice's terms are canonical JSON with sorted keys, UTF-8, no whitespace,
and a sha256 hash. The PDF prints every field and the hash. The core clauses are:

- **payment_instruction_v1**: "Payment of any amount to any address listed in
  this invoice or at its pay link discharges this invoice to that extent."
- **assignment_consent_v1**: "The debtor consents to the assignment of the right
  to receive payment; the payment addresses do not change on assignment."

The acknowledgement is an EIP-712 signature over the terms hash, the amount due
and the due date, verified on chain; NEAR debtors can call the acknowledgement
method directly. A claim transfer re-routes later payments.

The clauses are a technical record, not legal advice. Their effect depends on
the parties and the applicable law; counsel is needed before relying on them.
Openrail does not file documents, serve notices or pursue debtors.
