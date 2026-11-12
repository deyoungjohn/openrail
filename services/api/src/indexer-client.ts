/** HTTP indexer reads for receipts, statements and events (S3). */
import type { IndexerPort } from "./app.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface EventRow {
  id: number | string;
  event: string;
  time: string;
  tx_hash: string;
  token_id: string | null;
  data: Record<string, unknown>;
}

export function createHttpIndexer(baseUrl: string, fetchImpl: FetchLike = fetch): IndexerPort {
  const base = baseUrl.replace(/\/+$/, "");
  const get = async (path: string): Promise<Response> => fetchImpl(`${base}${path}`);
  return {
    async status() {
      const response = await get("/health");
      if (!response.ok) throw new Error(`INDEXER_HTTP_${response.status}`);
      const body = (await response.json()) as {
        last_polled_at?: unknown;
        boost_active?: unknown;
        source?: unknown;
        gaps?: unknown;
        oldest_gap_age?: unknown;
      };
      return {
        last_polled_at: typeof body.last_polled_at === "string" ? body.last_polled_at : null,
        boost_active: body.boost_active === true,
        source: body.source === "watcher" ? "watcher" : "scan",
        gaps: Array.isArray(body.gaps) ? body.gaps : [],
        oldest_gap_age: typeof body.oldest_gap_age === "number" ? body.oldest_gap_age : null,
      };
    },
    async issueTx(tokenId) {
      const response = await get(`/events?token_id=${encodeURIComponent(tokenId)}&limit=200`);
      if (!response.ok) return undefined;
      const body = (await response.json()) as { data?: EventRow[] };
      return (body.data ?? []).find((row) => row.event === "issue")?.tx_hash;
    },
    async listReceipts(_accountId, tokenId) {
      const response = await get(`/events?token_id=${encodeURIComponent(tokenId)}&limit=200`);
      if (!response.ok) throw new Error(`INDEXER_HTTP_${response.status}`);
      const body = (await response.json()) as { data?: EventRow[] };
      const receipts: Record<string, unknown>[] = [];
      for (const row of body.data ?? []) {
        if (row.event !== "booked") continue;
        const receiptResponse = await get(`/r/${encodeURIComponent(row.tx_hash)}`);
        if (!receiptResponse.ok) continue;
        const receiptBody = (await receiptResponse.json()) as { receipt?: Record<string, unknown> };
        // The booking transaction is always known, even when the provider's evidence is not (yet) verified.
        if (receiptBody.receipt !== undefined)
          receipts.push({ ...receiptBody.receipt, booking_tx: row.tx_hash });
      }
      return receipts;
    },
    async getReceipt(bookingTxHash) {
      const response = await get(`/r/${encodeURIComponent(bookingTxHash)}`);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`INDEXER_HTTP_${response.status}`);
      const body = (await response.json()) as { receipt?: Record<string, unknown> };
      return body.receipt;
    },
    async getStatement(_accountId, query) {
      const params = new URLSearchParams({ format: query.format });
      if (query.from !== undefined) params.set("from", query.from);
      if (query.to !== undefined) params.set("to", query.to);
      if (query.tokenId !== undefined) params.set("token_id", query.tokenId);
      const response = await get(`/statements?${params.toString()}`);
      if (!response.ok) throw new Error(`INDEXER_HTTP_${response.status}`);
      return (await response.json()) as Record<string, unknown>;
    },
    async analytics() {
      const response = await get("/analytics");
      if (!response.ok) throw new Error(`INDEXER_HTTP_${response.status}`);
      return (await response.json()) as Record<string, unknown>;
    },
    async listEvents(query) {
      const params = new URLSearchParams({ limit: String(query.limit ?? 50) });
      if (query.after !== undefined && query.after !== "") params.set("after", query.after);
      const response = await get(`/events?${params.toString()}`);
      if (!response.ok) throw new Error(`INDEXER_HTTP_${response.status}`);
      const body = (await response.json()) as {
        data?: EventRow[];
        next_cursor?: number | string | null;
      };
      const data = (body.data ?? [])
        .filter((row) => query.type === undefined || row.event === query.type)
        .map((row) => ({
          id: String(row.id),
          type: row.event,
          created: Math.floor(Date.parse(row.time) / 1000),
          data: { ...row.data, token_id: row.token_id, tx_hash: row.tx_hash },
        }));
      return {
        data,
        next_cursor:
          body.next_cursor === null || body.next_cursor === undefined
            ? null
            : String(body.next_cursor),
      };
    },
  };
}
