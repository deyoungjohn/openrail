/** RPC `EXPERIMENTAL_tx_status` reader used by register-tx and degraded discovery. */
import type { SourceReceipt } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TxStatusResult {
  receiverId: string;
  signerId: string;
  blockHeight: number;
  blockHash: string;
  blockTimestamp: number;
  receipts: SourceReceipt[];
}

export interface TxStatusReader {
  fetch(hash: string, signer: string): Promise<TxStatusResult>;
}

interface RpcReceiptOutcome {
  id?: string;
  block_height?: number;
  block_hash?: string;
  outcome?: { logs?: unknown; executor_id?: string };
}

interface RpcStatus {
  transaction?: { receiver_id?: string; signer_id?: string };
  transaction_outcome?: {
    block_hash?: string;
    block_height?: number;
    outcome?: { block_timestamp?: number };
  };
  receipts_outcome?: RpcReceiptOutcome[];
}

export class RpcTxStatusReader implements TxStatusReader {
  constructor(
    private readonly rpcUrls: string[],
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    if (rpcUrls.length === 0) throw new Error("NEAR_RPC_INVALID: at least one RPC URL");
  }

  async fetch(hash: string, signer: string): Promise<TxStatusResult> {
    let lastError: unknown;
    for (const url of this.rpcUrls) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "EXPERIMENTAL_tx_status",
            params: { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" },
          }),
          signal: AbortSignal.timeout(20_000),
        });
        const body = (await response.json()) as { result?: RpcStatus; error?: unknown };
        if (!response.ok || body.error !== undefined || body.result === undefined) {
          lastError = new Error(
            `RPC_TX_STATUS_FAILED: ${JSON.stringify(body.error ?? response.status)}`,
          );
          continue;
        }
        const result = body.result;
        const receipts: SourceReceipt[] = [];
        for (const outcome of result.receipts_outcome ?? []) {
          const logs = outcome.outcome?.logs;
          if (!Array.isArray(logs) || logs.length === 0) continue;
          receipts.push({
            receiptId: outcome.id ?? `${hash}:${receipts.length}`,
            txHash: hash,
            predecessorId: result.transaction?.receiver_id ?? "",
            receiverId: outcome.outcome?.executor_id ?? "",
            logs: logs.filter((log): log is string => typeof log === "string"),
          });
        }
        const first = result.receipts_outcome?.[0];
        return {
          receiverId: result.transaction?.receiver_id ?? "",
          signerId: result.transaction?.signer_id ?? signer,
          blockHeight: first?.block_height ?? result.transaction_outcome?.block_height ?? 0,
          blockHash: first?.block_hash ?? result.transaction_outcome?.block_hash ?? hash,
          blockTimestamp:
            result.transaction_outcome?.outcome?.block_timestamp ?? Math.floor(Date.now() / 1000),
          receipts,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("RPC_TX_STATUS_UNAVAILABLE");
  }
}
