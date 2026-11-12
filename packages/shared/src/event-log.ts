/** NEP-297 logs and the single-writer event table shared by the watcher and the payout worker. */
import { DatabaseSync } from "node:sqlite";

export const EVENT_PREFIX = "EVENT_JSON:";

export interface EventRow {
  event_key: string;
  tx_hash: string;
  receipt_id: string;
  block_height: number;
  timestamp: number;
  token_id: string | null;
  event: string;
  standard: "openrail" | "nep171";
  log_index: number;
  data_index: number;
  token_index: number;
  data_json: string;
  raw_json: string;
  origin_json: string | null;
  source: string;
}

export interface OutcomeLike {
  transaction?: { hash?: unknown };
  transaction_outcome?: { id?: unknown; block_height?: unknown };
  receipts_outcome?: {
    id?: unknown;
    block_height?: unknown;
    outcome?: { logs?: unknown; block_timestamp?: unknown } | null;
  }[];
}

export interface OutcomeContext {
  tokenId: string;
  blockHeight: number;
  timestamp: number;
  source?: string;
  origin?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenIds(event: string, data: Record<string, unknown>): (string | null)[] {
  if (event === "nft_mint" || event === "nft_transfer") {
    const ids = data.token_ids;
    if (Array.isArray(ids)) {
      const strings = ids.filter((id): id is string => typeof id === "string");
      return strings.length > 0 ? strings : [null];
    }
    return [null];
  }
  return [typeof data.token_id === "string" ? data.token_id : null];
}

export function parseEventLog(
  log: string,
  txHash: string,
  receiptId: string,
  logIndex: number,
): Omit<EventRow, "block_height" | "timestamp" | "origin_json" | "source">[] {
  if (!log.startsWith(EVENT_PREFIX)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(log.slice(EVENT_PREFIX.length));
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const standard = parsed.standard;
  const version = parsed.version;
  const event = parsed.event;
  const data = parsed.data;
  if (standard !== "openrail" && standard !== "nep171") return [];
  if (version !== "1.0.0" || typeof event !== "string" || !Array.isArray(data)) return [];

  const rows: Omit<EventRow, "block_height" | "timestamp" | "origin_json" | "source">[] = [];
  data.forEach((item, dataIndex) => {
    if (!isRecord(item)) return;
    tokenIds(event, item).forEach((tokenId, tokenIndex) => {
      rows.push({
        event_key: `${txHash}:${receiptId}:${logIndex}:${dataIndex}:${tokenIndex}`,
        tx_hash: txHash,
        receipt_id: receiptId,
        token_id: tokenId,
        event,
        standard,
        log_index: logIndex,
        data_index: dataIndex,
        token_index: tokenIndex,
        data_json: JSON.stringify(item),
        raw_json: log,
      });
    });
  });
  return rows;
}

export function rowsFromOutcome(outcome: OutcomeLike, context: OutcomeContext): EventRow[] {
  const txHash =
    typeof outcome.transaction?.hash === "string"
      ? outcome.transaction.hash
      : typeof outcome.transaction_outcome?.id === "string"
        ? outcome.transaction_outcome.id
        : "";
  const rows: EventRow[] = [];
  for (const receipt of outcome.receipts_outcome ?? []) {
    const logs = receipt.outcome?.logs;
    if (!Array.isArray(logs)) continue;
    const receiptId = typeof receipt.id === "string" ? receipt.id : `${txHash}:${rows.length}`;
    logs.forEach((log, logIndex) => {
      if (typeof log !== "string") return;
      for (const row of parseEventLog(log, txHash, receiptId, logIndex)) {
        rows.push({
          ...row,
          block_height: context.blockHeight,
          timestamp: context.timestamp,
          origin_json: context.origin === undefined ? null : JSON.stringify(context.origin),
          source: context.source ?? "watcher",
        });
      }
    });
  }
  return rows;
}

export function ensureEventTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_key TEXT PRIMARY KEY,
      tx_hash TEXT NOT NULL,
      receipt_id TEXT NOT NULL,
      block_height INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      token_id TEXT,
      event TEXT NOT NULL,
      standard TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      data_index INTEGER NOT NULL,
      token_index INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      origin_json TEXT,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_token ON events(token_id);
    CREATE INDEX IF NOT EXISTS events_tx ON events(tx_hash);
  `);
}

/** One transaction per outcome; repeated logs are ignored by the event key. */
export function appendOutcomeEvents(
  db: DatabaseSync,
  outcome: OutcomeLike,
  context: OutcomeContext,
): number {
  const rows = rowsFromOutcome(outcome, context);
  if (rows.length === 0) return 0;
  db.exec("BEGIN");
  try {
    const statement = db.prepare(
      "INSERT OR IGNORE INTO events (event_key, tx_hash, receipt_id, block_height, timestamp, token_id, event, standard, log_index, data_index, token_index, data_json, raw_json, origin_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      statement.run(
        row.event_key,
        row.tx_hash,
        row.receipt_id,
        row.block_height,
        row.timestamp,
        row.token_id,
        row.event,
        row.standard,
        row.log_index,
        row.data_index,
        row.token_index,
        row.data_json,
        row.raw_json,
        row.origin_json,
        row.source,
      );
    }
    db.exec("COMMIT");
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw new Error("EVENT_WRITE_FAILED");
  }
  return rows.length;
}

export function openEventDatabase(path: string): DatabaseSync | null {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .get();
    if (table === undefined) {
      db.close();
      return null;
    }
    return db;
  } catch {
    return null;
  }
}
