/** Local HTTP surface: history, statements, receipts, health (blueprint 2.9). */
import { buildStatement, PAYMENT_INSTRUCTION_V1 } from "./statements.js";
import type { Indexer } from "./indexer.js";
import type { IndexerStore, ReceiptRow } from "./store.js";
import type { ClaimReader } from "./types.js";

export interface IndexerAppDeps {
  store: IndexerStore;
  indexer: Indexer;
  claimReader?: ClaimReader;
  rootAccount: string;
}

export interface IndexerResponse {
  status: number;
  body: unknown;
}

function iso(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseLimit(value: string | null): number {
  const parsed = Number(value ?? "50");
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 200);
}

function eventJson(row: {
  id: number;
  event_key: string;
  block_height: number;
  block_hash: string;
  block_timestamp: number;
  tx_hash: string;
  event: string;
  token_id: string | null;
  data_json: string;
}): unknown {
  return {
    id: row.id,
    event_key: row.event_key,
    block_height: row.block_height,
    block_hash: row.block_hash,
    time: iso(row.block_timestamp),
    tx_hash: row.tx_hash,
    event: row.event,
    token_id: row.token_id,
    data: JSON.parse(row.data_json) as unknown,
  };
}

function receiptJson(row: ReceiptRow, rootAccount: string): unknown {
  const origin = row.origin_json === null ? null : (JSON.parse(row.origin_json) as unknown);
  const nearHashes =
    row.near_hashes_json === null ? [] : (JSON.parse(row.near_hashes_json) as unknown);
  return {
    receipt: {
      id: `rcpt_${row.tx_hash}`,
      token_id: row.token_id,
      amount: row.payment,
      asset: row.asset,
      time: iso(row.timestamp),
      claim_number: row.token_id,
      terms_hash: row.terms_hash,
      payment_instruction_v1: PAYMENT_INSTRUCTION_V1,
      origin_tx: origin,
      near_tx_hashes: nearHashes,
      verified: row.verified === 1,
    },
    verify_url: `/r/${row.tx_hash}`,
    claim_account: `${row.token_id}.${rootAccount}`,
  };
}

export function createIndexerApp(deps: IndexerAppDeps) {
  return {
    async handle(method: string, url: string): Promise<IndexerResponse> {
      const parsed = new URL(url, "http://127.0.0.1");
      const path = parsed.pathname;
      if (method !== "GET") {
        return { status: 405, body: { error: { code: "method_not_allowed" } } };
      }

      if (path === "/health") {
        return { status: 200, body: { ok: true, ...deps.indexer.health() } };
      }

      if (path === "/history" || path === "/events") {
        const tokenId = parsed.searchParams.get("token_id") ?? undefined;
        const after = Number(parsed.searchParams.get("after") ?? "0");
        const limit = parseLimit(parsed.searchParams.get("limit"));
        const rows = deps.store.eventsAfter(
          Number.isSafeInteger(after) && after >= 0 ? after : 0,
          limit,
          tokenId,
        );
        const last = rows[rows.length - 1];
        return {
          status: 200,
          body: { data: rows.map(eventJson), next_cursor: last?.id ?? null },
        };
      }

      if (path === "/statements") {
        const format = parsed.searchParams.get("format") === "pdf" ? "pdf" : "csv";
        const tokenId = parsed.searchParams.get("token_id") ?? undefined;
        const now = new Date();
        const to = parsed.searchParams.get("to") ?? now.toISOString().slice(0, 10);
        const from =
          parsed.searchParams.get("from") ??
          new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
        try {
          const envelope = await buildStatement(
            deps.store,
            { from, to, format, ...(tokenId === undefined ? {} : { tokenId }) },
            deps.claimReader,
            now,
          );
          return { status: 200, body: envelope };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === "INVALID_DATE" || message === "INVALID_RANGE") {
            return { status: 400, body: { error: { code: message.toLowerCase() } } };
          }
          throw error;
        }
      }

      const receiptMatch = /^\/r\/([^/]+)$/.exec(path);
      if (receiptMatch !== null) {
        const txHash = decodeURIComponent(receiptMatch[1] ?? "");
        const receipt = deps.store.receipt(txHash);
        if (receipt === null) {
          return { status: 404, body: { error: { code: "receipt_not_found" } } };
        }
        return { status: 200, body: receiptJson(receipt, deps.rootAccount) };
      }

      return { status: 404, body: { error: { code: "not_found" } } };
    },
  };
}
