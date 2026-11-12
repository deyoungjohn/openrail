/**
 * Ingestion loop: account-scoped final event pages → SQLite, opaque resumable cursor,
 * idempotent event keys, receipt enrichment, retention pruning.
 */
import type { Logger } from "@openrail/shared";
import type { EventSink, ReceiptEnricher, EventSource } from "./types.js";
import type { IndexerStore } from "./store.js";
import type { BudgetGovernor } from "./budget.js";
import type { TxStatusReader } from "./tx-status.js";

export const DEFAULT_POLL_INTERVAL_MS = 30 * 60 * 1000;
export const BOOST_POLL_INTERVAL_MS = 60_000;
export const BOOST_DURATION_MS = 5 * 60 * 1000;

export interface IndexerOptions {
  source: EventSource;
  store: IndexerStore;
  sink?: EventSink;
  enricher?: ReceiptEnricher;
  maxPagesPerSync?: number;
  pollIntervalMs?: number;
  retentionDays?: number;
  logger: Logger;
  now?: () => number;
  budget?: BudgetGovernor;
  rootAccount?: string;
  txStatus?: TxStatusReader;
  from?: string;
}

export interface SyncResult {
  latest_block: number;
  blocks: number;
  events: number;
  pages: number;
  calls: Record<string, number>;
}

export class Indexer {
  private readonly source: EventSource;
  private readonly store: IndexerStore;
  private readonly sink: EventSink | undefined;
  private readonly enricher: ReceiptEnricher | undefined;
  private readonly maxPagesPerSync: number;
  private readonly pollIntervalMs: number;
  private readonly retentionDays: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly budget?: BudgetGovernor;
  private readonly rootAccount?: string;
  private readonly txStatus?: TxStatusReader;
  private readonly from?: string;
  private lastHead: number | null = null;
  private lastPolledAt: string | null = null;
  private boostUntil = 0;

  constructor(options: IndexerOptions) {
    this.source = options.source;
    this.store = options.store;
    this.sink = options.sink;
    this.enricher = options.enricher;
    this.maxPagesPerSync = Math.max(1, options.maxPagesPerSync ?? 5);
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.retentionDays = Math.max(1, options.retentionDays ?? 30);
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.budget = options.budget;
    this.rootAccount = options.rootAccount;
    this.txStatus = options.txStatus;
    this.from = options.from;
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

  /** Fetches pages until the source says it is done, the page budget is hit, or no progress. */
  async syncOnce(): Promise<SyncResult> {
    const stored = this.store.cursor();
    let cursor = stored?.sourceCursor ?? null;
    let latestBlock = stored?.height ?? 0;
    let blocks = 0;
    let events = 0;
    let pages = 0;

    for (;;) {
      const page = await this.source.fetch(cursor);
      pages += 1;
      latestBlock = Math.max(latestBlock, page.latestBlock);
      const ordered = [...page.blocks].sort((a, b) => a.height - b.height);
      for (const block of ordered) {
        const inserted = this.store.ingestBlock(block);
        blocks += 1;
        events += inserted.length;
        latestBlock = Math.max(latestBlock, block.height);
        for (const event of inserted) {
          await this.emit(event);
          await this.enrich(event);
        }
      }
      const last = ordered[ordered.length - 1];
      this.store.setCursor(
        last === undefined ? latestBlock : Math.max(latestBlock, last.height),
        last?.hash ?? stored?.blockHash ?? "",
        page.cursor ?? cursor,
      );

      const previous = cursor;
      cursor = page.cursor;
      if (page.done || pages >= this.maxPagesPerSync) break;
      if (cursor === null || cursor === previous) break;
    }

    this.lastHead = latestBlock;
    this.lastPolledAt = new Date(this.now()).toISOString();
    const calls = this.source.callCounts?.() ?? {};
    this.logger.info("indexed", { latestBlock, blocks, events, pages, calls });
    return { latest_block: latestBlock, blocks, events, pages, calls };
  }

  /** Raise the polling cadence to one minute for five minutes (bounded by the remaining budget). */
  poke(): number {
    if (this.budget !== undefined && this.budget.health().remaining <= 0) return 0;
    // A poke while a boost is running does not extend it: every price and every cash-out pokes, and a chain of
    // extensions meant a tick every few seconds all day.
    if (this.now() >= this.boostUntil) this.boostUntil = this.now() + BOOST_DURATION_MS;
    return this.boostUntil;
  }

  /** Verify a reported transaction and ingest its contract receipts. */
  async registerTx(
    hash: string,
    signer: string,
  ): Promise<{ accepted: boolean; reason?: string; events: number }> {
    if (this.txStatus === undefined || this.rootAccount === undefined) {
      return { accepted: false, reason: "register_tx_not_configured", events: 0 };
    }
    const status = await this.txStatus.fetch(hash, signer);
    if (!this.isAcceptedReceiver(status.receiverId))
      return { accepted: false, reason: "receiver_not_root", events: 0 };
    const inserted = this.store.ingestBlock({
      height: status.blockHeight,
      hash: status.blockHash,
      timestamp: status.blockTimestamp,
      receipts: status.receipts,
    });
    for (const event of inserted) {
      await this.emit(event);
      await this.enrich(event);
    }
    return { accepted: true, events: inserted.length };
  }

  /** Root, or a known claim account under the root (old `c-n` and labelled alike). */
  private isAcceptedReceiver(receiver: string): boolean {
    if (this.rootAccount === undefined) return false;
    if (receiver === this.rootAccount) return true;
    const suffix = `.${this.rootAccount}`;
    if (!receiver.endsWith(suffix)) return false;
    const label = receiver.slice(0, -suffix.length);
    return label !== "" && this.store.hasClaim(label);
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
      const interval = this.now() < this.boostUntil ? BOOST_POLL_INTERVAL_MS : this.pollIntervalMs;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  health(): {
    cursor: ReturnType<IndexerStore["cursor"]>;
    last_head: number | null;
    last_polled_at: string | null;
    events: number;
    claims: number;
    bookings: number;
    quotes: number;
    acks: number;
    transfers: number;
    calls: Record<string, number>;
    poll_interval_ms: number;
    boost_until: number;
    boost_active: boolean;
    from: string | null;
    caught_up: boolean | null;
    degraded: boolean;
    nearblocks_budget?: ReturnType<BudgetGovernor["health"]>;
  } {
    return {
      ...this.store.health(),
      last_head: this.lastHead,
      last_polled_at: this.lastPolledAt,
      calls: this.source.callCounts?.() ?? {},
      poll_interval_ms: this.pollIntervalMs,
      boost_until: this.boostUntil,
      boost_active: this.now() < this.boostUntil,
      from: this.from ?? null,
      caught_up: this.source.caughtUp?.() ?? null,
      degraded: this.budget?.health().blocked ?? false,
      ...(this.budget === undefined ? {} : { nearblocks_budget: this.budget.health() }),
    };
  }
}
