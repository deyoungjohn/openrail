/** NEP-297 log parsing and validation (blueprint 2.9). */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventTokenIds(event: string, data: Record<string, unknown>): (string | null)[] {
  if (event === "nft_mint" || event === "nft_transfer") {
    const tokenIds = data.token_ids;
    if (Array.isArray(tokenIds)) {
      const strings = tokenIds.filter((id): id is string => typeof id === "string");
      return strings.length > 0 ? strings : [null];
    }
    return [null];
  }
  return [typeof data.token_id === "string" ? data.token_id : null];
}

/** Parses one receipt's logs. Malformed or non-indexed logs are ignored. */
export function parseReceipt(block: SourceBlock, receipt: SourceReceipt): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  receipt.logs.forEach((log, logIndex) => {
    if (!log.startsWith(EVENT_PREFIX)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(log.slice(EVENT_PREFIX.length));
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const standard = parsed.standard;
    const version = parsed.version;
    const event = parsed.event;
    const data = parsed.data;
    if (standard !== "openrail" && standard !== "nep171") return;
    if (version !== "1.0.0" || typeof event !== "string" || !Array.isArray(data)) return;

    data.forEach((item, dataIndex) => {
      if (!isRecord(item)) return;
      eventTokenIds(event, item).forEach((tokenId, tokenIndex) => {
        events.push({
          eventKey: `${receipt.txHash}:${receipt.receiptId}:${logIndex}:${dataIndex}:${tokenIndex}`,
          blockHeight: block.height,
          blockHash: block.hash,
          blockTimestamp: toSeconds(block.timestamp),
          txHash: receipt.txHash,
          receiptId: receipt.receiptId,
          logIndex,
          dataIndex,
          standard,
          version,
          event,
          tokenId,
          data: item,
          raw: log,
        });
      });
    });
  });
  return events;
}

/** Parses every valid event in a final block, in log order. */
export function parseBlock(block: SourceBlock): ParsedEvent[] {
  return block.receipts.flatMap((receipt) => parseReceipt(block, receipt));
}
