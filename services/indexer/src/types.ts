/** Event-source and record shapes for the indexer (blueprint 2.9, 1.6). */

export interface SourceReceipt {
  receiptId: string;
  txHash: string;
  predecessorId: string;
  receiverId: string;
  logs: string[];
}

export interface SourceBlock {
  height: number;
  hash: string;
  /** Unix seconds (final block). */
  timestamp: number;
  receipts: SourceReceipt[];
}

/**
 * Account-scoped event feed (NearBlocks in production). `cursor` is opaque to the indexer and
 * stored in SQLite; a null cursor means "start from the oldest available page". The source only
 * returns final data.
 */
export interface SourcePage {
  blocks: SourceBlock[];
  cursor: string | null;
  done: boolean;
  latestBlock: number;
}

export interface EventSource {
  fetch(cursor: string | null): Promise<SourcePage>;
  /** HTTP/RPC calls per feature, for the load budget. */
  callCounts?(): Record<string, number>;
}

export interface ParsedEvent {
  eventKey: string;
  blockHeight: number;
  blockHash: string;
  blockTimestamp: number;
  txHash: string;
  receiptId: string;
  logIndex: number;
  dataIndex: number;
  standard: "openrail" | "nep171";
  version: string;
  event: string;
  tokenId: string | null;
  data: Record<string, unknown>;
  raw: string;
}

export interface EventSink {
  /** Called once for each newly indexed event (never for duplicates). */
  emit(event: ParsedEvent): Promise<void>;
}

export interface ClaimViewTotals {
  token_id: string;
  amount_due: string;
  booked_total: string;
  distributed_total: string;
  fee_total: string;
  surplus: string;
  credit_total: string;
  status: string;
  terms_hash: string;
  due_date: number;
}

/** Reads `claim()` for statement reconciliation; tests fake it. */
export interface ClaimReader {
  claim(tokenId: string): Promise<ClaimViewTotals | null>;
}

export interface ReceiptEvidence {
  origin_tx: {
    chain: string;
    hash: string;
    sender: string;
    amount: string;
  } | null;
  near_tx_hashes: string[];
  verified: boolean;
}

/** Enriches a `booked` receipt with 1Click origin/NEAR hashes. */
export interface ReceiptEnricher {
  enrich(booking: {
    tokenId: string;
    txHash: string;
    payment: string;
    asset: string;
    blockTimestamp: number;
  }): Promise<ReceiptEvidence>;
}

export interface StatementRange {
  from: string;
  to: string;
  tokenId?: string;
  format: "csv" | "pdf";
}
