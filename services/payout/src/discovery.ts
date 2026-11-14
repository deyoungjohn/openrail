/** Discover claim ids with settle_held events from the indexer. */
import type { HeldDiscovery } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class IndexerHeldDiscovery implements HeldDiscovery {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  /** `settle_held` events seen per token in the last read: a token with the same count as before has nothing new. */
  readonly counts = new Map<string, number>();

  async tokens(): Promise<string[]> {
    const tokens = new Set<string>();
    this.counts.clear();
    let after = "0";
    for (let page = 0; page < 50; page += 1) {
      const response = await this.fetchImpl(`${this.baseUrl}/events?after=${after}&limit=200`);
      if (!response.ok) throw new Error(`INDEXER_HTTP_${response.status}`);
      const body = (await response.json()) as {
        data?: { event?: unknown; token_id?: unknown }[];
        next_cursor?: number | string | null;
      };
      for (const row of body.data ?? []) {
        if (
          (row.event === "settle_held" || row.event === "checkout_refund_started") &&
          typeof row.token_id === "string" &&
          row.token_id !== ""
        ) {
          tokens.add(row.token_id);
          if (row.event === "settle_held")
            this.counts.set(row.token_id, (this.counts.get(row.token_id) ?? 0) + 1);
        }
      }
      const next =
        body.next_cursor === undefined || body.next_cursor === null
          ? null
          : String(body.next_cursor);
      if (next === null || next === "" || next === after) break;
      after = next;
    }
    return [...tokens];
  }
}
