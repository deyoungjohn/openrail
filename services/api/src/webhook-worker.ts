/** Webhook delivery worker: indexer cursor -> signed deliveries, retries for 24 h. */
import { randomUUID } from "node:crypto";
import type { IndexerPort } from "./app.js";
import type { ApiStore, OutboxRow } from "./stores.js";
import { deliverWebhook, type IndexedEvent } from "./webhooks.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WebhookWorkerDeps {
  events: Pick<IndexerPort, "listEvents">;
  store: ApiStore;
  fetchImpl?: FetchLike;
  clock?: () => Date;
  limit?: number;
  retryWindowMs?: number;
  logger?: (message: string, data?: Record<string, unknown>) => void;
}

export class WebhookWorker {
  private cursor: string | undefined;
  private readonly clock: () => Date;
  private readonly limit: number;
  private readonly retryWindowMs: number;
  private readonly fetchImpl?: FetchLike;
  private readonly log: (message: string, data?: Record<string, unknown>) => void;

  constructor(private readonly deps: WebhookWorkerDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.limit = deps.limit ?? 100;
    this.retryWindowMs = deps.retryWindowMs ?? 24 * 60 * 60 * 1000;
    this.fetchImpl = deps.fetchImpl;
    this.log = deps.logger ?? (() => undefined);
  }

  /** One poll + delivery pass. Safe to call repeatedly; the outbox is the exactly-once ledger. */
  async runOnce(): Promise<void> {
    const now = this.clock().getTime();
    await this.deliverDue(now);

    const page = await this.deps.events.listEvents({
      ...(this.cursor === undefined ? {} : { after: this.cursor }),
      limit: this.limit,
    });
    const endpoints = this.deps.store.listWebhookEndpoints();
    for (const raw of page.data) {
      const event = { ...raw, indexed: true } as unknown as IndexedEvent;
      for (const endpoint of endpoints) {
        if (!endpoint.events.includes(event.type)) continue;
        this.deps.store.outboxEnqueue(
          endpoint.id,
          event.id,
          JSON.stringify(event),
          now,
          now + this.retryWindowMs,
        );
      }
    }
    if (page.next_cursor !== undefined && page.next_cursor !== null) {
      this.cursor = page.next_cursor;
    }
    await this.deliverDue(this.clock().getTime());
  }

  private async deliverDue(now: number): Promise<void> {
    for (const row of this.deps.store.outboxDue(now)) {
      await this.deliverRow(row, now);
    }
  }

  private async deliverRow(row: OutboxRow, now: number): Promise<void> {
    const endpoint = this.deps.store.getWebhookEndpoint(row.endpointId);
    if (endpoint === undefined) {
      this.deps.store.outboxExpire(row.endpointId, row.eventId);
      return;
    }
    let event: IndexedEvent;
    try {
      event = JSON.parse(row.event) as IndexedEvent;
    } catch {
      this.deps.store.outboxExpire(row.endpointId, row.eventId);
      return;
    }
    const attempt = row.attempt + 1;
    try {
      const result = await deliverWebhook(endpoint, event, {
        ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
        clock: () => now,
      });
      const delivered = result.statusCode >= 200 && result.statusCode < 300;
      this.deps.store.addDelivery(endpoint.id, {
        id: `whd_${randomUUID()}`,
        endpoint_id: endpoint.id,
        event_id: event.id,
        type: event.type,
        attempt,
        status_code: result.statusCode,
        delivered_at: delivered ? new Date(now).toISOString() : null,
        error: delivered ? null : result.body,
      });
      if (delivered) {
        this.deps.store.outboxMarkDelivered(endpoint.id, event.id);
        this.log("webhook delivered", { endpoint: endpoint.id, event: event.id, attempt });
        return;
      }
      this.retry(row, now, attempt, result.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.addDelivery(endpoint.id, {
        id: `whd_${randomUUID()}`,
        endpoint_id: endpoint.id,
        event_id: event.id,
        type: event.type,
        attempt,
        status_code: 0,
        delivered_at: null,
        error: message,
      });
      this.retry(row, now, attempt, message);
    }
  }

  private retry(row: OutboxRow, now: number, attempt: number, error: string): void {
    if (now >= row.expiresAt) {
      this.deps.store.outboxExpire(row.endpointId, row.eventId);
      this.log("webhook expired", { endpoint: row.endpointId, event: row.eventId, attempt, error });
      return;
    }
    const delay = Math.min(1000 * 2 ** Math.min(attempt, 10), 60 * 60 * 1000);
    this.deps.store.outboxReschedule(row.endpointId, row.eventId, attempt, now + delay);
    this.log("webhook retry scheduled", { endpoint: row.endpointId, event: row.eventId, attempt });
  }
}
