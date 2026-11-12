/** NEP-297 log parsing and validation (blueprint 2.9). */
import { parseEventLog } from "@openrail/shared";
import { toSeconds } from "./time.js";
import type { ParsedEvent, SourceBlock, SourceReceipt } from "./types.js";

export const EVENT_PREFIX = "EVENT_JSON:";

/** Events that are evidence and are never pruned. */
export const EVIDENCE_EVENTS = new Set([
  "issue",
  "storage_sponsored",
  "ack",
  "quote_logged",
  "booked",
  "distributed",
  "distribution_failed",
  "surplus",
  "surplus_released",
  "cancel",
  "close",
  "writeoff",
  "nft_mint",
  "nft_transfer",
  "unmatched",
  "anomaly",
]);

/** Operational events that may be pruned after the retention window. */
export const PRUNABLE_EVENTS = new Set([
  "reconcile_failed",
  "lock_cleared",
  "transfer_window",
  "config_changed",
]);

/** Parses one receipt's logs. Malformed or non-indexed logs are ignored. */
export function parseReceipt(block: SourceBlock, receipt: SourceReceipt): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  receipt.logs.forEach((log, logIndex) => {
    for (const row of parseEventLog(log, receipt.txHash, receipt.receiptId, logIndex)) {
      events.push({
        eventKey: row.event_key,
        blockHeight: block.height,
        blockHash: block.hash,
        blockTimestamp: toSeconds(block.timestamp),
        txHash: receipt.txHash,
        receiptId: receipt.receiptId,
        logIndex,
        dataIndex: row.data_index,
        standard: row.standard,
        version: "1.0.0",
        event: row.event,
        tokenId: row.token_id,
        data: JSON.parse(row.data_json) as Record<string, unknown>,
        raw: log,
      });
    }
  });
  return events;
}

/** Parses every valid event in a final block, in log order. */
export function parseBlock(block: SourceBlock): ParsedEvent[] {
  return block.receipts.flatMap((receipt) => parseReceipt(block, receipt));
}
