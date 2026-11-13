/**
 * Account-scoped production source.
 *
 * NearBlocks v3 lists the transactions that touch `<root>` (`/v3/accounts/<root>/txns`),
 * newest-first, paged with an opaque `next_page` cursor. The list rows have no logs, so each new
 * transaction is read once with `EXPERIMENTAL_tx_status` (`wait_until: FINAL`); only receipts
 * executed by `<root>` are kept.
 *
 * The cursor is `v3:<newest height>:<next page>`. A finished page stores an empty next page, so the
 * next poll starts at the newest transaction and walks back until it meets the stored height. While
 * walking a large backlog the cursor keeps v3's opaque next page, so no transaction is skipped.
 */
import type { BudgetGovernor } from "./budget.js";
import { toSeconds } from "./time.js";
import type { EventSource, SourceBlock, SourcePage, SourceReceipt } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface NbBlockRef {
  block_height?: number | string;
  block_timestamp?: number | string;
  block_hash?: string;
}

interface NbTxn {
  transaction_hash?: string;
  signer_account_id?: string;
  /** Receipt rows (`/receipts`) carry no signer; any account works as the sender for an archival tx-status read. */
  predecessor_account_id?: string;
  receiver_account_id?: string;
  block?: NbBlockRef | null;
  receipt_block?: NbBlockRef | null;
  block_timestamp?: number | string;
  included_in_block_hash?: string;
}

interface NbResponse {
  data?: NbTxn[];
  meta?: { next_page?: string | null };
}

interface TxStatus {
  receipts_outcome?: {
    id?: string;
    outcome?: { logs?: unknown; executor_id?: string } | null;
  }[];
}

interface ParsedCursor {
  latest: number;
  floor: number;
  nextPage: string | null;
}

const timestampSeconds = toSeconds;

function parseCursor(cursor: string | null): ParsedCursor {
  if (cursor === null) return { latest: 0, floor: 0, nextPage: null };
  // Cursors written before the v3 migration stored just the newest height; keep them readable.
  const legacy = /^h:(\d+)$/.exec(cursor);
  if (legacy?.[1] !== undefined) {
    const height = Number(legacy[1]);
    return { latest: height, floor: height, nextPage: null };
  }
  if (cursor.startsWith("v3:")) {
    const rest = cursor.slice(3);
    const first = rest.indexOf(":");
    const second = first === -1 ? -1 : rest.indexOf(":", first + 1);
    if (first !== -1 && second !== -1) {
      const latest = Number(rest.slice(0, first));
      const floor = Number(rest.slice(first + 1, second));
      const encoded = rest.slice(second + 1);
      const nextPage = encoded === "" ? null : Buffer.from(encoded, "base64url").toString("utf8");
      return {
        latest: Number.isFinite(latest) ? latest : 0,
        floor: Number.isFinite(floor) ? floor : 0,
        nextPage,
      };
    }
  }
  return { latest: 0, floor: 0, nextPage: null };
}

function encodeCursor(latest: number, floor: number, nextPage: string | null): string {
  const encoded = nextPage === null ? "" : Buffer.from(nextPage).toString("base64url");
  return `v3:${latest}:${floor}:${encoded}`;
}

function rowHeight(tx: NbTxn): number {
  const value = tx.receipt_block?.block_height ?? tx.block?.block_height ?? 0;
  return typeof value === "number" ? value : Number(value) || 0;
}

export class NearBlocksEventSource implements EventSource {
  private readonly baseUrl: string;
  private readonly apiKeys: string[];
  private readonly rpcUrls: string[];
  private readonly fetchImpl: FetchLike;
  private readonly limit: number;
  private readonly maxPages: number;
  private readonly counts = new Map<string, number>();
  private reached = false;

  constructor(
    private readonly rootAccount: string,
    baseUrl = "https://api.nearblocks.io",
    apiKey: string | readonly string[] = "",
    rpcUrls: string[] = [],
    fetchImpl: FetchLike = (input, init) => fetch(input, init),
    limit = 25,
    maxPages = 5,
    private readonly budget?: BudgetGovernor,
    private readonly fromSeconds = 0,
    private readonly shouldRead: (txHash: string) => boolean = () => true,
    /**
     * Backfill of one claim: list `listAccount`'s receipts (a claim account signs no transaction, so its `/txns` list
     * is empty; every forward, payout and surplus release is a receipt to or from it), and keep the root's logs.
     */
    private readonly scope: { listAccount: string; listing: "receipts" } | undefined = undefined,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKeys = (typeof apiKey === "string" ? [apiKey] : [...apiKey]).filter((k) => k !== "");
    this.rpcUrls = rpcUrls;
    this.fetchImpl = fetchImpl;
    this.limit = Math.max(1, Math.min(limit, 25));
    this.maxPages = Math.max(1, maxPages);
  }

  callCounts(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  caughtUp(): boolean {
    return this.reached;
  }

  private increment(feature: string): void {
    this.counts.set(feature, (this.counts.get(feature) ?? 0) + 1);
  }

  private async listPage(nextPage: string | null): Promise<NbResponse> {
    if (this.budget !== undefined) await this.budget.beforeCall();
    // With several keys each takes its own share of the day (the governor says which one is on).
    const apiKey =
      this.apiKeys[Math.min(this.budget?.keyIndex() ?? 0, this.apiKeys.length - 1)] ?? "";
    const query = new URLSearchParams({ limit: String(this.limit) });
    if (nextPage !== null) query.set("next", nextPage);
    const account = this.scope?.listAccount ?? this.rootAccount;
    const listing = this.scope?.listing ?? "txns";
    const url = `${this.baseUrl}/v3/accounts/${encodeURIComponent(account)}/${listing}?${query.toString()}`;
    this.increment(`nearblocks.${listing}`);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` }),
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
    const sender = tx.signer_account_id ?? tx.predecessor_account_id;
    if (typeof tx.transaction_hash !== "string" || typeof sender !== "string") return [];
    const status = await this.txStatus(tx.transaction_hash, sender);
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
    const parsed = parseCursor(cursor);
    const storedHeight = parsed.floor;
    let next: string | null = parsed.nextPage;
    let latestBlock = parsed.latest;
    let done = false;
    const blocks = new Map<number, SourceBlock>();
    // A transaction shows once per receipt in a receipt listing: read its status once.
    const readHashes = new Set<string>();

    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      const body = await this.listPage(next);
      const txns = Array.isArray(body.data) ? body.data : [];
      let reachedStored = false;
      let lastHeight = storedHeight;
      for (const tx of txns) {
        const height = rowHeight(tx);
        lastHeight = Math.max(lastHeight, height);
        const txTimestamp = timestampSeconds(
          tx.receipt_block?.block_timestamp ?? tx.block?.block_timestamp ?? tx.block_timestamp,
        );
        if (this.fromSeconds > 0 && txTimestamp > 0 && txTimestamp < this.fromSeconds) {
          reachedStored = true;
          continue;
        }
        if (height <= storedHeight) {
          reachedStored = true;
          continue;
        }
        latestBlock = Math.max(latestBlock, height);
        if (typeof tx.transaction_hash === "string") {
          if (readHashes.has(tx.transaction_hash) || !this.shouldRead(tx.transaction_hash))
            continue;
          readHashes.add(tx.transaction_hash);
        }
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
      latestBlock = Math.max(latestBlock, lastHeight);
      next = body.meta?.next_page ?? null;
      if (reachedStored || next === null || txns.length === 0) {
        done = true;
        next = null;
        break;
      }
      if (pageIndex === this.maxPages - 1) break;
    }

    this.reached = done;
    const ordered = [...blocks.values()].sort((a, b) => a.height - b.height);
    const nextCursor = encodeCursor(
      latestBlock,
      done ? latestBlock : storedHeight,
      done ? null : next,
    );
    return { blocks: ordered, cursor: nextCursor, done, latestBlock };
  }
}
