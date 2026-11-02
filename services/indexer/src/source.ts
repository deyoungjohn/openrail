import { getEnv, requireEnv } from "@openrail/shared";

/**
 * Production event source: scans final NEAR blocks over JSON-RPC.
 *
 * For each final block, read its chunks, keep transactions whose receiver is the root account,
 * fetch their outcomes, and collect every receipt log. Callbacks to the root account are inside
 * those transactions' `receipts_outcome`. Only `final` blocks are returned.
 */
import type { EventSource, SourceBlock, SourceReceipt } from "./types.js";

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
  const primary = requireEnv("NEAR_RPC_URL");
  const fallback = getEnv("NEAR_RPC_URL_FALLBACK");
  return [...primary.split(","), ...(fallback === undefined ? [] : [fallback])]
    .map((url) => url.trim())
    .filter((url) => url !== "");
}

export class RpcEventSource implements EventSource {
  private readonly urls: string[];
  private readonly fetchImpl: FetchLike;
  private readonly rootAccount: string;

  constructor(
    rootAccount: string,
    urls: string[],
    fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    if (urls.length === 0) throw new Error("NEAR_RPC_INVALID: at least one RPC URL");
    this.rootAccount = rootAccount;
    this.urls = urls;
    this.fetchImpl = fetchImpl;
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    let lastError: unknown;
    for (const url of this.urls) {
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

  async finalHead(): Promise<number> {
    const block = await this.rpc<RpcBlock>("block", { finality: "final" });
    const height = block.header?.height;
    if (typeof height !== "number") throw new Error("RPC_INVALID_RESULT: final block height");
    return height;
  }

  private async receiptsForTransaction(hash: string, signerId: string): Promise<SourceReceipt[]> {
    const status = await this.rpc<RpcTxStatus>("tx", [hash, signerId]);
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

  async fetchRange(fromHeight: number, toHeight: number): Promise<SourceBlock[]> {
    const blocks: SourceBlock[] = [];
    for (let height = fromHeight; height <= toHeight; height += 1) {
      const block = await this.rpc<RpcBlock>("block", { block_id: height });
      const hash = block.header?.hash;
      if (typeof hash !== "string") throw new Error(`RPC_INVALID_RESULT: block ${height}`);
      const timestamp = Number(BigInt(block.header?.timestamp ?? 0) / 1_000_000_000n);
      const receipts: SourceReceipt[] = [];
      for (const chunkRef of block.chunks ?? []) {
        const chunkHash = chunkRef.chunk_hash;
        if (typeof chunkHash !== "string") continue;
        const chunk = await this.rpc<RpcChunk>("chunk", { chunk_id: chunkHash });
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
}
