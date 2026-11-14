/**
 * Settle indexer policy. Core already stores unknown module events raw; this module marks the
 * held-entry events as evidence so a pruning pass cannot drop the audit trail.
 */
export const SETTLE_EVIDENCE_EVENTS = new Set([
  "settle_held",
  "settle_sent",
  "settle_settled",
  "settle_released",
]);
