/**
 * Account-scoped production source: NearBlocks v3 receipts for `<root>`, newest page first.
 * The cursor is our own `h:<height>`: fetch the newest page(s), keep only blocks above it, and
 * stop once a page reaches already-indexed heights. One request per quiet poll.
 */
import type { EventSource, SourceBlock, SourcePage, SourceReceipt } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface NbBlockRef {
  block_height?: number;
  block_timestamp?: number | string;
  block_hash?: string;
}

interface NbReceipt {
  receipt_id?: string;
  receiptId?: string;
  transaction_hash?: string;
  tx_hash?: string;
  block?: NbBlockRef | null;
  block_height?: number;
  block_timestamp?: number | string;
  block_hash?: string;
  predecessor_account_id?: string;
  receiver_account_id?: string;
  outcome?: { logs?: unknown } | null;
  receipts?: NbReceipt[];
}

interface NbResponse {
  data?: NbReceipt[];
  meta?: { next_page?: string | null; prev_page?: string | null };
}

interface PageState {
  height: number;
  hash: string;
  timestamp: number;
  receipts: SourceReceipt[];
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
  private readonly fetchImpl: FetchLike;
  private readonly limit: number;
  private readonly maxPages: number;
  private calls = 0;

  constructor(
    private readonly rootAccount: string,
    baseUrl = "https://api.nearblocks.io",
    apiKey = "",
    fetchImpl: FetchLike = (input, init) => fetch(input, init),
    limit = 100,
    maxPages = 5,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.limit = Math.max(1, Math.min(limit, 100));
    this.maxPages = Math.max(1, maxPages);
  }

  callCounts(): Record<string, number> {
    return { "nearblocks.receipts": this.calls };
  }

  private walk(
    node: NbReceipt,
    inherited: { height: number; hash: string; timestamp: number; txHash?: string },
    pages: Map<number, PageState>,
  ): void {
    const height = node.block?.block_height ?? node.block_height ?? inherited.height ?? 0;
    const hash = node.block?.block_hash ?? node.block_hash ?? inherited.hash ?? `h${height}`;
    const timestamp =
      timestampSeconds(node.block?.block_timestamp ?? node.block_timestamp) ||
      inherited.timestamp ||
      0;
    const txHash =
      node.transaction_hash ??
      node.tx_hash ??
      inherited.txHash ??
      node.receipt_id ??
      node.receiptId ??
      `r${height}`;
    const logs = node.outcome?.logs;
    if (Array.isArray(logs) && logs.some((log) => typeof log === "string")) {
      const page = pages.get(height) ?? { height, hash, timestamp, receipts: [] };
      page.receipts.push({
        receiptId: node.receipt_id ?? node.receiptId ?? `${txHash}:${page.receipts.length}`,
        txHash,
        predecessorId: node.predecessor_account_id ?? "",
        receiverId: node.receiver_account_id ?? this.rootAccount,
        logs: logs.filter((log): log is string => typeof log === "string"),
      });
      pages.set(height, page);
    }
    for (const child of node.receipts ?? []) {
      this.walk(child, { height, hash, timestamp, txHash }, pages);
    }
  }

  async fetch(cursor: string | null): Promise<SourcePage> {
    const storedHeight = cursorHeight(cursor);
    const pages = new Map<number, PageState>();
    let latestBlock = storedHeight;
    let next: string | null = null;
    let done = false;
    let oldestHeight = Number.POSITIVE_INFINITY;

    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      const query = new URLSearchParams({ limit: String(this.limit) });
      if (next !== null) query.set("next", next);
      const url = `${this.baseUrl}/v3/accounts/${encodeURIComponent(this.rootAccount)}/receipts?${query.toString()}`;
      this.calls += 1;
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(this.apiKey === "" ? {} : { authorization: `Bearer ${this.apiKey}` }),
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(`NEARBLOCKS_HTTP_${response.status}`);
      }
      const body = (await response.json()) as NbResponse;
      const data = Array.isArray(body.data) ? body.data : [];
      const heights: number[] = [];
      for (const receipt of data) {
        this.walk(receipt, { height: 0, hash: "", timestamp: 0 }, pages);
        const height = receipt.block?.block_height ?? receipt.block_height;
        if (typeof height === "number") heights.push(height);
      }
      latestBlock = Math.max(latestBlock, ...heights);
      next = body.meta?.next_page ?? null;
      const oldest = heights.length === 0 ? null : Math.min(...heights);
      if (oldest !== null) oldestHeight = Math.min(oldestHeight, oldest);
      if (next === null || (oldest !== null && oldest <= storedHeight)) {
        done = true;
        break;
      }
    }

    const blocks: SourceBlock[] = [...pages.values()]
      .filter((page) => page.height > storedHeight)
      .sort((a, b) => a.height - b.height)
      .map((page) => ({
        height: page.height,
        hash: page.hash,
        timestamp: page.timestamp,
        receipts: page.receipts,
      }));
    latestBlock = Math.max(latestBlock, ...blocks.map((block) => block.height));
    const nextCursor =
      done || !Number.isFinite(oldestHeight)
        ? latestBlock
        : Math.max(storedHeight, oldestHeight - 1);
    return { blocks, cursor: `h:${nextCursor}`, done, latestBlock };
  }
}
