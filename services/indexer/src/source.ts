/**
 * Off-by-default RPC block scanner (kept as a documented test/fallback source).
 * Production uses the account-scoped NearBlocks source; scanning every final block is ~1M
 * calls/day at mainnet block time and is only for tests or an emergency fallback.
 */
import { nearRpcUrlsFromEnv } from "@openrail/shared";
import type { EventSource, SourceBlock, SourcePage, SourceReceipt } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface RpcBlock {
  header?: { height?: number; hash?: string; timestamp?: number | string };
  chunks?: { chunk_hash?: string }[];
}

interface RpcChunk {
  transactions?: { hash?: string; receiver_id?: string; signer_id?: string }[];
}

interface RpcTxStatus {
  receipts_outcome?: {
    id?: string;
    outcome?: { logs?: string[]; executor_id?: string };
  }[];
}

const REQUEST_TIMEOUT_MS = 20_000;

export function nearRpcUrls(): string[] {
  return nearRpcUrlsFromEnv();
}

function cursorHeight(cursor: string | null): number {
  if (cursor === null) return 0;
  const match = /^h:(\d+)$/.exec(cursor);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

export class RpcEventSource implements EventSource {
  private readonly urls: string[];
  private readonly fetchImpl: FetchLike;
  private readonly rootAccount: string;
  private readonly startHeight: number;
  private readonly counts = new Map<string, number>();

  constructor(
    rootAccount: string,
    urls: string[],
    startHeight = 0,
    fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    if (urls.length === 0) throw new Error("NEAR_RPC_INVALID: at least one RPC URL");
    this.rootAccount = rootAccount;
    this.urls = urls;
    this.startHeight = startHeight;
    this.fetchImpl = fetchImpl;
  }

  callCounts(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  private increment(feature: string): void {
    this.counts.set(feature, (this.counts.get(feature) ?? 0) + 1);
  }

  private async rpc<T>(method: string, params: unknown, feature: string): Promise<T> {
    let lastError: unknown;
    for (const url of this.urls) {
      this.increment(feature);
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          lastError = new Error(`RPC_HTTP_${response.status}`);
          continue;
        }
        const body = (await response.json()) as { result?: T; error?: unknown };
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

  private async finalHead(): Promise<number> {
    const block = await this.rpc<RpcBlock>("block", { finality: "final" }, "rpc.block.final");
    const height = block.header?.height;
    if (typeof height !== "number") throw new Error("RPC_INVALID_RESULT: final block height");
    return height;
  }

  private async receiptsForTransaction(hash: string, signerId: string): Promise<SourceReceipt[]> {
    const status = await this.rpc<RpcTxStatus>("tx", [hash, signerId], "rpc.tx");
    const receipts: SourceReceipt[] = [];
    for (const outcome of status.receipts_outcome ?? []) {
      const logs = outcome.outcome?.logs;
      if (!Array.isArray(logs) || logs.length === 0) continue;
      receipts.push({
        receiptId: outcome.id ?? `${hash}:${receipts.length}`,
        txHash: hash,
        predecessorId: "",
        receiverId: outcome.outcome?.executor_id ?? this.rootAccount,
        logs,
      });
    }
    return receipts;
  }

  private async fetchRange(fromHeight: number, toHeight: number): Promise<SourceBlock[]> {
    const blocks: SourceBlock[] = [];
    for (let height = fromHeight; height <= toHeight; height += 1) {
      const block = await this.rpc<RpcBlock>("block", { block_id: height }, "rpc.block");
      const hash = block.header?.hash;
      if (typeof hash !== "string") throw new Error(`RPC_INVALID_RESULT: block ${height}`);
      const timestamp = Number(BigInt(block.header?.timestamp ?? 0) / 1_000_000_000n);
      const receipts: SourceReceipt[] = [];
      for (const chunkRef of block.chunks ?? []) {
        const chunkHash = chunkRef.chunk_hash;
        if (typeof chunkHash !== "string") continue;
        const chunk = await this.rpc<RpcChunk>("chunk", { chunk_id: chunkHash }, "rpc.chunk");
        for (const transaction of chunk.transactions ?? []) {
          if (transaction.receiver_id !== this.rootAccount) continue;
          if (typeof transaction.hash !== "string" || typeof transaction.signer_id !== "string") {
            continue;
          }
          receipts.push(
            ...(await this.receiptsForTransaction(transaction.hash, transaction.signer_id)),
          );
        }
      }
      blocks.push({ height, hash, timestamp, receipts });
    }
    return blocks;
  }

  async fetch(cursor: string | null): Promise<SourcePage> {
    const storedHeight = cursorHeight(cursor);
    const start = Math.max(storedHeight + 1, this.startHeight);
    const head = await this.finalHead();
    if (start > head) {
      return { blocks: [], cursor: `h:${head}`, done: true, latestBlock: head };
    }
    const blocks = await this.fetchRange(start, head);
    const latest = blocks[blocks.length - 1]?.height ?? head;
    return { blocks, cursor: `h:${latest}`, done: true, latestBlock: head };
  }
}
