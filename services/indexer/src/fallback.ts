/** Tries the account-scoped source first; uses the RPC scanner only when it fails. */
import type { EventSource, SourcePage } from "./types.js";

export class FallbackEventSource implements EventSource {
  constructor(
    private readonly primary: EventSource,
    private readonly fallback: EventSource,
  ) {}

  async fetch(cursor: string | null): Promise<SourcePage> {
    try {
      return await this.primary.fetch(cursor);
    } catch {
      return this.fallback.fetch(cursor);
    }
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
