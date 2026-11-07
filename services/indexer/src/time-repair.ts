import type { BudgetGovernor } from "./budget.js";
import { toSeconds } from "./time.js";

export interface TimeRepairStore {
  badTimeTxs(): { txHash: string; blockHeight: number }[];
  setTxTime(txHash: string, seconds: number): void;
}

export type RepairFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The block's time from a NEAR RPC node (free; only recent blocks are kept unless the node is an archive). */
async function rpcBlockSeconds(
  rpcUrls: readonly string[],
  height: number,
  fetchImpl: RepairFetch,
): Promise<number> {
  for (const url of rpcUrls) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "block",
          params: { block_id: height },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json()) as {
        result?: { header?: { timestamp?: number | string } };
      };
      const seconds = toSeconds(body.result?.header?.timestamp);
      if (seconds >= 1_000_000_000) return seconds;
    } catch {
      /* try the next node */
    }
  }
  return 0;
}

/**
 * Rows written by the old time bug carry a time in 1970. The real block time is still public. Ask a NEAR RPC
 * node for the block (free, one call per block), and only for blocks it no longer has ask NearBlocks (it
 * counts against the daily budget, and is skipped when that is spent). A row that cannot be fixed keeps its
 * bad time and is tried again next round. Returns how many transactions were fixed.
 */
export async function repairTimes(options: {
  store: TimeRepairStore;
  rpcUrls?: readonly string[];
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: RepairFetch;
  budget?: Pick<BudgetGovernor, "beforeCall" | "recordCall">;
  log?: (message: string) => void;
}): Promise<number> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const byHeight = new Map<number, number>();
  let fixed = 0;
  for (const { txHash, blockHeight } of options.store.badTimeTxs()) {
    try {
      let seconds = 0;
      if (blockHeight > 0 && options.rpcUrls !== undefined && options.rpcUrls.length > 0) {
        if (!byHeight.has(blockHeight))
          byHeight.set(blockHeight, await rpcBlockSeconds(options.rpcUrls, blockHeight, fetchImpl));
        seconds = byHeight.get(blockHeight) ?? 0;
      }
      if (seconds < 1_000_000_000 && options.baseUrl !== undefined) {
        await options.budget?.beforeCall();
        const response = await fetchImpl(
          `${options.baseUrl.replace(/\/+$/, "")}/v1/txns/${encodeURIComponent(txHash)}`,
          {
            headers:
              options.apiKey === undefined || options.apiKey === ""
                ? {}
                : { authorization: `Bearer ${options.apiKey}` },
            signal: AbortSignal.timeout(20_000),
          },
        );
        options.budget?.recordCall();
        if (response.ok) {
          const body = (await response.json()) as {
            txns?: { block_timestamp?: string | number }[];
          };
          seconds = toSeconds(body.txns?.[0]?.block_timestamp);
        }
      }
      if (seconds < 1_000_000_000) continue;
      options.store.setTxTime(txHash, seconds);
      fixed += 1;
    } catch (error) {
      options.log?.(`time repair skipped ${txHash.slice(0, 8)}: ${String(error).slice(0, 80)}`);
    }
  }
  return fixed;
}
