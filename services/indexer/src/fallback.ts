/** Tries the account-scoped source first; uses the RPC scanner only when it fails. */
import { BudgetExhaustedError } from "./budget.js";
import type { EventSource, SourcePage } from "./types.js";

export class FallbackEventSource implements EventSource {
  constructor(
    private readonly primary: EventSource,
    private readonly fallback: EventSource,
  ) {}

  async fetch(cursor: string | null): Promise<SourcePage> {
    try {
      return await this.primary.fetch(cursor);
    } catch (error) {
      if (error instanceof BudgetExhaustedError) throw error;
      return this.fallback.fetch(cursor);
    }
  }

  caughtUp(): boolean {
    return this.primary.caughtUp?.() ?? true;
  }

  callCounts(): Record<string, number> {
    const merged: Record<string, number> = {};
    for (const source of [this.primary, this.fallback]) {
      for (const [feature, count] of Object.entries(source.callCounts?.() ?? {})) {
        merged[feature] = (merged[feature] ?? 0) + count;
      }
    }
    return merged;
  }
}
