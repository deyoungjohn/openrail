/**
 * Account-scoped production source.
 *
 * NearBlocks lists the transactions that touch `<root>` (`/v1/account/<root>/txns`, cursor
 * paging). The list rows have no logs, so each new transaction is read once with
 * `EXPERIMENTAL_tx_status` (`wait_until: FINAL`); only receipts executed by `<root>` are kept.
 *
 * The cursor is our own `h:<height>`: fetch the newest page(s), keep transactions above it,
 * and stop once a page reaches already-indexed heights. A quiet poll is one NearBlocks call.
 */
import type { BudgetGovernor } from "./budget.js";
import type { EventSource, SourceBlock, SourcePage, SourceReceipt } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface NbBlockRef {
  block_height?: number;
  block_timestamp?: number | string;
  block_hash?: string;
}

interface NbTxn {
  transaction_hash?: string;
  signer_account_id?: string;
  receiver_account_id?: string;
  block?: NbBlockRef | null;
  receipt_block?: NbBlockRef | null;
  block_timestamp?: number | string;
  included_in_block_hash?: string;
}

interface NbResponse {
  cursor?: string | null;
  txns?: NbTxn[];
  meta?: { next_page?: string | null };
}

interface TxStatus {
  receipts_outcome?: {
    id?: string;
    outcome?: { logs?: unknown; executor_id?: string } | null;
  }[];
}

function timestampSeconds(value: number | string | undefined): number {
  if (value === undefined) return 0;
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric > 1_000_000_000_000 ? Math.floor(numeric / 1_000_000_000) : Math.floor(numeric);
}

function cursorHeight(cursor: string | null): number {
  if (cursor === null) return 0;
  const match = /^h:(\d+)$/.exec(cursor);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

export class NearBlocksEventSource implements EventSource {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly rpcUrls: string[];
  private readonly fetchImpl: FetchLike;
  private readonly limit: number;
  private readonly maxPages: number;
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly rootAccount: string,
    baseUrl = "https://api.nearblocks.io",
    apiKey = "",
    rpcUrls: string[] = [],
    fetchImpl: FetchLike = (input, init) => fetch(input, init),
    limit = 100,
    maxPages = 5,
    private readonly budget?: BudgetGovernor,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.rpcUrls = rpcUrls;
    this.fetchImpl = fetchImpl;
    this.limit = Math.max(1, Math.min(limit, 100));
    this.maxPages = Math.max(1, maxPages);
  }

  callCounts(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  private increment(feature: string): void {
    this.counts.set(feature, (this.counts.get(feature) ?? 0) + 1);
  }

  private async listPage(cursor: string | null): Promise<NbResponse> {
    if (this.budget !== undefined) await this.budget.beforeCall();
    const query = new URLSearchParams({ limit: String(this.limit) });
    if (cursor !== null) query.set("cursor", cursor);
    const url = `${this.baseUrl}/v1/account/${encodeURIComponent(this.rootAccount)}/txns?${query.toString()}`;
    this.increment("nearblocks.txns");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(this.apiKey === "" ? {} : { authorization: `Bearer ${this.apiKey}` }),
        },
        signal: AbortSignal.timeout(20_000),
      });
    } finally {
      this.budget?.recordCall();
    }
    if (response.status === 429) this.budget?.on429();
    if (!response.ok) throw new Error(`NEARBLOCKS_HTTP_${response.status}`);
    return (await response.json()) as NbResponse;
  }

  private async txStatus(txHash: string, signerId: string): Promise<TxStatus> {
    let lastError: unknown;
    for (const url of this.rpcUrls) {
      this.increment("rpc.tx_status");
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "EXPERIMENTAL_tx_status",
            params: {
              tx_hash: txHash,
              sender_account_id: signerId,
              wait_until: "FINAL",
            },
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          lastError = new Error(`RPC_HTTP_${response.status}`);
          continue;
        }
        const body = (await response.json()) as { result?: TxStatus; error?: unknown };
        if (body.error !== undefined) {
          lastError = new Error(`RPC_ERROR: ${JSON.stringify(body.error)}`);
          continue;
        }
        if (body.result === undefined) {
          lastError = new Error("RPC_RESULT_MISSING");
          continue;
        }
        return body.result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("RPC_UNAVAILABLE");
  }

  private async rootLogs(tx: NbTxn): Promise<SourceReceipt[]> {
    if (typeof tx.transaction_hash !== "string" || typeof tx.signer_account_id !== "string") {
      return [];
    }
    const status = await this.txStatus(tx.transaction_hash, tx.signer_account_id);
    const receipts: SourceReceipt[] = [];
    for (const outcome of status.receipts_outcome ?? []) {
      if (outcome.outcome?.executor_id !== this.rootAccount) continue;
      const logs = outcome.outcome.logs;
      if (!Array.isArray(logs) || !logs.some((log) => typeof log === "string")) continue;
      receipts.push({
        receiptId: outcome.id ?? `${tx.transaction_hash}:${receipts.length}`,
        txHash: tx.transaction_hash,
        predecessorId: tx.receiver_account_id ?? "",
        receiverId: this.rootAccount,
        logs: logs.filter((log): log is string => typeof log === "string"),
      });
    }
    return receipts;
  }

  async fetch(cursor: string | null): Promise<SourcePage> {
    const storedHeight = cursorHeight(cursor);
    let next: string | null = null;
    let latestBlock = storedHeight;
    let oldestHeight = Number.POSITIVE_INFINITY;
    let done = false;
    const blocks = new Map<number, SourceBlock>();

    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      const body = await this.listPage(next);
      const txns = Array.isArray(body.txns) ? body.txns : [];
      const heights: number[] = [];
      for (const tx of txns) {
        const height = tx.receipt_block?.block_height ?? tx.block?.block_height ?? 0;
        if (height <= storedHeight) continue;
        heights.push(height);
        latestBlock = Math.max(latestBlock, height);
        const receipts = await this.rootLogs(tx);
        if (receipts.length === 0) continue;
        const hash = tx.receipt_block?.block_hash ?? tx.block?.block_hash ?? `h${height}`;
        const timestamp = timestampSeconds(
          tx.receipt_block?.block_timestamp ?? tx.block?.block_timestamp ?? tx.block_timestamp,
        );
        const block = blocks.get(height) ?? { height, hash, timestamp, receipts: [] };
        block.receipts.push(...receipts);
        blocks.set(height, block);
      }
      if (heights.length > 0) oldestHeight = Math.min(oldestHeight, ...heights);
      next = body.cursor ?? body.meta?.next_page ?? null;
      if (
        next === null ||
        txns.length === 0 ||
        (heights.length > 0 && oldestHeight <= storedHeight)
      ) {
        done = true;
        break;
      }
    }

    const ordered = [...blocks.values()].sort((a, b) => a.height - b.height);
    latestBlock = Math.max(latestBlock, ...ordered.map((block) => block.height));
    const nextCursor =
      done || !Number.isFinite(oldestHeight)
        ? latestBlock
        : Math.max(storedHeight, oldestHeight - 1);
    return { blocks: ordered, cursor: `h:${nextCursor}`, done, latestBlock };
  }
}
