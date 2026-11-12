/**
 * Imports events that other single-writer services recorded in SQLite (watcher, payout worker).
 * No NearBlocks or RPC call is made for a transaction already in one of these files.
 */
import { openEventDatabase } from "@openrail/shared";
import type { EventSource, SourceBlock, SourcePage, SourceReceipt } from "./types.js";

interface Row {
  rowid: number;
  tx_hash: string;
  receipt_id: string;
  block_height: number;
  timestamp: number;
  log_index: number;
  raw_json: string;
}

interface Cursor {
  [path: string]: number;
}

function parseCursor(cursor: string | null): Cursor {
  if (cursor === null || !cursor.startsWith("ev:")) return {};
  try {
    const value = JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString("utf8"));
    return value !== null && typeof value === "object" ? (value as Cursor) : {};
  } catch {
    return {};
  }
}

function encodeCursor(cursor: Cursor): string {
  return `ev:${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`;
}

export class IndexerEventSource implements EventSource {
  private counts = 0;

  constructor(private readonly paths: readonly string[]) {}

  callCounts(): Record<string, number> {
    return { "event_sources.reads": this.counts };
  }

  async fetch(cursor: string | null): Promise<SourcePage> {
    const positions = parseCursor(cursor);
    const blocks = new Map<number, SourceBlock>();
    const receipts = new Map<string, SourceReceipt & { logsByIndex: Map<number, string> }>();
    let latestBlock = 0;

    for (const path of this.paths) {
      const db = openEventDatabase(path);
      if (db === null) continue;
      try {
        const rows = db
          .prepare(
            "SELECT rowid, tx_hash, receipt_id, block_height, timestamp, log_index, raw_json FROM events WHERE rowid > ? ORDER BY rowid LIMIT 1000",
          )
          .all(positions[path] ?? 0) as unknown as Row[];
        for (const row of rows) {
          positions[path] = row.rowid;
          this.counts += 1;
          latestBlock = Math.max(latestBlock, Number(row.block_height));
          const block =
            blocks.get(Number(row.block_height)) ??
            ({
              height: Number(row.block_height),
              hash: `events:${row.block_height}`,
              timestamp: Number(row.timestamp),
              receipts: [],
            } satisfies SourceBlock);
          blocks.set(block.height, block);
          const key = `${row.tx_hash}:${row.receipt_id}`;
          let receipt = receipts.get(key);
          if (receipt === undefined) {
            receipt = {
              receiptId: row.receipt_id,
              txHash: row.tx_hash,
              predecessorId: "",
              receiverId: "",
              logs: [],
              logsByIndex: new Map(),
            };
            receipts.set(key, receipt);
            block.receipts.push(receipt);
          }
          receipt.logsByIndex.set(Number(row.log_index), row.raw_json);
        }
      } finally {
        db.close();
      }
    }

    for (const receipt of receipts.values()) {
      const max = Math.max(-1, ...receipt.logsByIndex.keys());
      receipt.logs = Array.from(
        { length: max + 1 },
        (_, index) => receipt.logsByIndex.get(index) ?? "",
      );
    }
    const ordered = [...blocks.values()].sort((a, b) => a.height - b.height);
    return { blocks: ordered, cursor: encodeCursor(positions), done: true, latestBlock };
  }
}
