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

  async tokens(): Promise<string[]> {
    const tokens = new Set<string>();
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
          row.event === "settle_held" &&
          typeof row.token_id === "string" &&
          row.token_id !== ""
        ) {
          tokens.add(row.token_id);
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
