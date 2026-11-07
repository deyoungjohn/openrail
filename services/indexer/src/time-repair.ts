import type { BudgetGovernor } from "./budget.js";
import { toSeconds } from "./time.js";

export interface TimeRepairStore {
  txHashesWithBadTime(): string[];
  setTxTime(txHash: string, seconds: number): void;
}

export type RepairFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Rows written by the old time bug carry a time in 1970. The block time of each transaction is still
 * public: ask NearBlocks for it (spaced by the budget governor) and write it back. A transaction that
 * cannot be found keeps its bad time and is tried again at the next start. Returns how many were fixed.
 */
export async function repairTimes(options: {
  store: TimeRepairStore;
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: RepairFetch;
  budget?: Pick<BudgetGovernor, "beforeCall" | "recordCall">;
  log?: (message: string) => void;
}): Promise<number> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let fixed = 0;
  for (const hash of options.store.txHashesWithBadTime()) {
    try {
      await options.budget?.beforeCall();
      const response = await fetchImpl(
        `${options.baseUrl.replace(/\/+$/, "")}/v1/txns/${encodeURIComponent(hash)}`,
        {
          headers:
            options.apiKey === undefined || options.apiKey === ""
              ? {}
              : { authorization: `Bearer ${options.apiKey}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      options.budget?.recordCall();
      if (!response.ok) continue;
      const body = (await response.json()) as { txns?: { block_timestamp?: string | number }[] };
      const seconds = toSeconds(body.txns?.[0]?.block_timestamp);
      if (seconds < 1_000_000_000) continue;
      options.store.setTxTime(hash, seconds);
      fixed += 1;
    } catch (error) {
      options.log?.(`time repair skipped ${hash.slice(0, 8)}: ${String(error).slice(0, 80)}`);
    }
  }
  return fixed;
}
