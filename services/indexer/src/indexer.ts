/** Ingestion loop: final blocks → SQLite, resumable cursor, idempotent, enrichment, pruning. */
import type { Logger } from "@openrail/shared";
import type { EventSink, ReceiptEnricher, EventSource } from "./types.js";
import type { IndexerStore } from "./store.js";

export interface IndexerOptions {
  source: EventSource;
  store: IndexerStore;
  sink?: EventSink;
  enricher?: ReceiptEnricher;
  startHeight?: number;
  batchBlocks?: number;
  pollIntervalMs?: number;
  retentionDays?: number;
  logger: Logger;
  now?: () => number;
}

export interface SyncResult {
  head: number;
  blocks: number;
  events: number;
}

export class Indexer {
  private readonly source: EventSource;
  private readonly store: IndexerStore;
  private readonly sink: EventSink | undefined;
  private readonly enricher: ReceiptEnricher | undefined;
  private readonly startHeight: number;
  private readonly batchBlocks: number;
  private readonly pollIntervalMs: number;
  private readonly retentionDays: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private lastHead: number | null = null;

  constructor(options: IndexerOptions) {
    this.source = options.source;
    this.store = options.store;
    this.sink = options.sink;
    this.enricher = options.enricher;
    this.startHeight = options.startHeight ?? 0;
    this.batchBlocks = Math.max(1, options.batchBlocks ?? 100);
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 5_000);
    this.retentionDays = Math.max(1, options.retentionDays ?? 30);
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  private async enrich(event: { event: string; eventKey: string }): Promise<void> {
    if (event.event !== "booked" || this.enricher === undefined) return;
    const booking = this.store.bookingByEventKey(event.eventKey);
    if (booking === null) return;
    try {
      const evidence = await this.enricher.enrich({
        tokenId: booking.token_id,
        txHash: booking.tx_hash,
        payment: booking.payment,
        asset: booking.asset,
        blockTimestamp: booking.block_timestamp,
      });
      this.store.updateReceiptEvidence(event.eventKey, evidence);
    } catch (error) {
      this.logger.warn(
        "receipt enrichment failed",
        booking.tx_hash,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async emit(event: Parameters<EventSink["emit"]>[0]): Promise<void> {
    if (this.sink === undefined) return;
    try {
      await this.sink.emit(event);
    } catch (error) {
      this.logger.warn(
        "webhook emission failed",
        event.eventKey,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** One pass from the cursor to the current final head. */
  async syncOnce(): Promise<SyncResult> {
    const head = await this.source.finalHead();
    this.lastHead = head;
    const cursor = this.store.cursor();
    let next = cursor === null ? this.startHeight : cursor.height + 1;
    if (next > head) return { head, blocks: 0, events: 0 };

    let blocks = 0;
    let events = 0;
    while (next <= head) {
      const end = Math.min(head, next + this.batchBlocks - 1);
      const range = await this.source.fetchRange(next, end);
      if (range.length === 0) break;
      const ordered = [...range].sort((a, b) => a.height - b.height);
      for (const block of ordered) {
        if (block.height > head) continue;
        const inserted = this.store.ingestBlock(block);
        blocks += 1;
        events += inserted.length;
        for (const event of inserted) {
          await this.emit(event);
          await this.enrich(event);
        }
      }
      const highest = ordered[ordered.length - 1]?.height;
      if (highest === undefined) break;
      next = highest + 1;
    }
    this.logger.info("indexed", { head, blocks, events });
    return { head, blocks, events };
  }

  /** Deletes prunable operational events; evidence kinds are never touched. */
  prune(nowMs: number = this.now()): number {
    const cutoff = Math.floor(nowMs / 1000) - this.retentionDays * 86_400;
    const deleted = this.store.pruneTransient(cutoff);
    if (deleted > 0) this.logger.info("pruned transient events", deleted);
    return deleted;
  }

  async run(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted === true) break;
      try {
        await this.syncOnce();
        this.prune();
      } catch (error) {
        this.logger.error(
          "indexer tick failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  health(): {
    cursor: ReturnType<IndexerStore["cursor"]>;
    last_head: number | null;
    events: number;
    claims: number;
    bookings: number;
    quotes: number;
    acks: number;
    transfers: number;
  } {
    return { ...this.store.health(), last_head: this.lastHead };
  }
}
